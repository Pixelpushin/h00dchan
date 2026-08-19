"use client";

// Lets a holder prove they control a real X account whose bio names
// hoodchan.org - no OAuth, no account linking. They sign a message proving
// wallet ownership (same personal_sign flow as claiming), get back a
// random, funny, on-brand phrase (lib/bioVerifyPhrase.ts) that always
// includes the site's own URL, post it themselves wherever they want, then
// this checks whether it's actually in their BIO specifically (a tweet
// alone doesn't count - the phrase mentions posting one too, but only for
// extra reach, since a tweet scrolls away and a bio doesn't). See
// app/api/bio-verify/start and /check for the server side.
//
// One primary action per step, not a row of separate buttons - copying the
// phrase and opening the bio-edit page used to be two clicks (a copy
// button plus a separate link), collapsed into one here. Tweeting stays
// available but as a plain inline link, not a full button, since it's
// explicitly optional bonus reach, not a required step.
import { useState } from "react";
import { connectWallet, signMessage } from "@/lib/wallet";
import { buildBioVerifyAuthMessage } from "@/lib/persona";

interface BioVerifyPanelProps {
  tokenId: string;
  initiallyVerified: boolean;
}

type Stage = "idle" | "connecting" | "awaiting-post" | "checking" | "verified";

function tweetIntentUrl(phrase: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(phrase)}`;
}

export function BioVerifyPanel({
  tokenId,
  initiallyVerified,
}: BioVerifyPanelProps) {
  const [stage, setStage] = useState<Stage>(
    initiallyVerified ? "verified" : "idle",
  );
  const [xHandle, setXHandle] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleStart = async () => {
    const handle = xHandle.trim().replace(/^@/, "");
    if (!handle) {
      setError("Enter your X (Twitter) username first - the part after the @.");
      return;
    }
    setStage("connecting");
    setError(null);
    try {
      const address = await connectWallet();
      const issuedAt = new Date().toISOString();
      const message = buildBioVerifyAuthMessage(tokenId, address, issuedAt);
      const signature = await signMessage(address, message);

      const res = await fetch("/api/bio-verify/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tokenId,
          address,
          signature,
          issuedAt,
          xHandle: handle,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
      setPhrase(data.phrase);
      setStage("awaiting-post");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start.");
      setStage("idle");
    }
  };

  const handleCopyAndOpenBio = async (phraseText: string) => {
    try {
      await navigator.clipboard.writeText(phraseText);
      setCopied(true);
    } catch {
      // Clipboard permission can be denied - the phrase is still visible
      // and selectable in the code block, so this isn't a dead end.
    }
    window.open(
      "https://x.com/settings/profile",
      "_blank",
      "noopener,noreferrer",
    );
  };

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/bio-verify/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
      if (data.verified) {
        setStage("verified");
      } else {
        setError(
          "Not seeing it in your bio yet - a tweet alone doesn't count, it needs to be in your actual bio text. Give X a minute to update, then try again.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check failed.");
    } finally {
      setChecking(false);
    }
  };

  if (stage === "verified") {
    return (
      <div
        className="hc-thread-meta text-xs"
        style={{ color: "var(--hc-greentext)" }}
      >
        ✓ X bio verified - +200 XP
      </div>
    );
  }

  if (stage === "awaiting-post" && phrase) {
    return (
      <div className="hc-box p-3 flex flex-col gap-2">
        <p className="text-xs font-medium">Almost done - one more step</p>
        <p className="hc-thread-meta text-xs">
          This goes in your X <strong>bio</strong> (that&apos;s the part
          that&apos;s actually checked), not just a tweet.
        </p>
        <code className="text-sm">{phrase}</code>
        <button
          onClick={() => handleCopyAndOpenBio(phrase)}
          className="hc-button text-xs self-start"
        >
          {copied ? "Copied - opening your bio..." : "Copy & open my X bio"}
        </button>
        <a
          href={tweetIntentUrl(phrase)}
          target="_blank"
          rel="noopener noreferrer"
          className="hc-link text-xs self-start"
        >
          or tweet it too, optional, for extra reach
        </a>
        <button
          onClick={handleCheck}
          disabled={checking}
          className="hc-button-ghost hc-button text-xs self-start"
        >
          {checking ? "Checking..." : "I updated my bio, check now"}
        </button>
        {error && (
          <p className="text-xs" style={{ color: "#a12b2b" }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium">
        Verify your X (Twitter) account - +200 XP
      </p>
      <p className="hc-thread-meta text-xs">
        Prove you control a real X account by putting a short phrase in your
        bio. No login, no permissions - we never touch your account, we just
        check your public bio text.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={xHandle}
          onChange={(e) => setXHandle(e.target.value)}
          placeholder="your X username, e.g. hoodchan"
          className="hc-form-input text-sm flex-1 min-w-0"
        />
        <button
          onClick={handleStart}
          disabled={stage === "connecting"}
          className="hc-button-ghost hc-button text-xs shrink-0"
        >
          {stage === "connecting" ? "Connecting..." : "Verify"}
        </button>
      </div>
      {error && (
        <p className="text-xs" style={{ color: "#a12b2b" }}>
          {error}
        </p>
      )}
    </div>
  );
}
