"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useActivePersona } from "@/lib/usePersona";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { postJsonAsPersona } from "@/lib/postAsPersona";
import { useDraftField } from "@/lib/useDraft";
import type { Post } from "@/lib/store";

export function ReplyForm({ threadId }: { threadId: string }) {
  const router = useRouter();
  const { persona, reauthorize } = useActivePersona();
  const address = useWalletAddress();
  // Keyed per-thread - replying in two different threads shouldn't share
  // or clobber each other's draft.
  const [body, setBody] = useDraftField(`h00dchan:draft:reply:${threadId}`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // See NewThreadForm for why this can't hydration-mismatch: the server
  // snapshot is always null, same as this branch.
  if (!persona) {
    // Wallet connection (AppKit, its own persistent session) and "which
    // anon am I posting as" (sessionStorage, per-TAB) are two separate
    // things - a real holder who already claimed their tokens still lands
    // here with an empty persona in any FRESH tab (a bookmark, a link from
    // elsewhere, a new tab), since sessionStorage doesn't carry over. The
    // old copy told a fully-claimed, wallet-connected holder to "connect
    // your wallet and claim a token" as if they'd done neither - caught
    // live from a real user's report. This only says that when there's
    // genuinely no wallet connected; a connected wallet gets pointed at
    // the actual fix (pick an anon on the home page), not a repeat of
    // something already done.
    return (
      <div className="hc-box p-4 text-sm">
        {address ? (
          <>
            Your wallet&apos;s connected, but you haven&apos;t picked which anon
            to post as in this tab yet.{" "}
            <Link href="/" className="hc-link">
              Pick one on the home page
            </Link>{" "}
            to reply to this thread.
          </>
        ) : (
          <>
            <Link href="/" className="hc-link">
              Connect your wallet and activate an anon
            </Link>{" "}
            to reply to this thread.
          </>
        )}
      </div>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await postJsonAsPersona<{ post: Post }>(
        `/api/threads/${threadId}/posts`,
        { body: body.trim() },
        persona,
        reauthorize,
      );
      setBody("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to post reply.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="hc-box p-4 flex flex-col gap-2">
      <div className="hc-post-tokenid text-sm">
        Replying as Anon #{persona.tokenId}
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Comment (lines starting with > are greentext)"
        rows={3}
        maxLength={4000}
        className="hc-form-input"
        disabled={submitting}
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="hc-button">
          {submitting ? "Posting..." : "Reply"}
        </button>
        {error && (
          <span className="text-sm" style={{ color: "var(--hc-danger)" }}>
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
