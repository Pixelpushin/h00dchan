"use client";

// Lets a holder prove they control a real X account whose bio names
// hoodchan.org - no OAuth, no account linking. They sign a message proving
// wallet ownership (same personal_sign flow as claiming), get back a
// random, funny, on-brand phrase (lib/bioVerifyPhrase.ts), post it
// themselves wherever they want, then this checks whether it's actually
// there. See app/api/bio-verify/start and /check for the server side.
import { useState } from "react";
import { connectWallet, signMessage } from "@/lib/wallet";
import { buildBioVerifyAuthMessage } from "@/lib/persona";
import { CopyButton } from "@/app/components/CopyButton";

interface BioVerifyPanelProps {
  tokenId: string;
  initiallyVerified: boolean;
}

type Stage = "idle" | "connecting" | "awaiting-post" | "checking" | "verified";

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

  const handleStart = async () => {
    const handle = xHandle.trim().replace(/^@/, "");
    if (!handle) {
      setError("Enter your X handle first.");
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
          "Not seeing it yet - make sure you posted the exact phrase, then try again.",
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
        ✓ Bio verified - +200 XP
      </div>
    );
  }

  if (stage === "awaiting-post" && phrase) {
    return (
      <div className="hc-box p-3 flex flex-col gap-2">
        <p className="hc-thread-meta text-xs">
          Post this exact phrase to your X bio (a tweet too, for extra reach)
          within an hour, then check:
        </p>
        <div className="flex items-center gap-2">
          <code className="text-sm flex-1">{phrase}</code>
          <CopyButton text={phrase} />
        </div>
        <button
          onClick={handleCheck}
          disabled={checking}
          className="hc-button text-xs self-start"
        >
          {checking ? "Checking..." : "I posted it, check now"}
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
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={xHandle}
          onChange={(e) => setXHandle(e.target.value)}
          placeholder="@yourhandle"
          className="hc-form-input text-sm"
        />
        <button
          onClick={handleStart}
          disabled={stage === "connecting"}
          className="hc-button-ghost hc-button text-xs shrink-0"
        >
          {stage === "connecting" ? "Connecting..." : "Verify bio (+200 XP)"}
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
