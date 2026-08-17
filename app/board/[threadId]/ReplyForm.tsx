"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useActivePersona } from "@/lib/usePersona";
import { postJsonAsPersona } from "@/lib/postAsPersona";
import { useDraftField } from "@/lib/useDraft";
import type { Post } from "@/lib/store";

export function ReplyForm({ threadId }: { threadId: string }) {
  const router = useRouter();
  const { persona, reauthorize } = useActivePersona();
  // Keyed per-thread - replying in two different threads shouldn't share
  // or clobber each other's draft.
  const [body, setBody] = useDraftField(`h00dchan:draft:reply:${threadId}`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // See NewThreadForm for why this can't hydration-mismatch: the server
  // snapshot is always null, same as this branch.
  if (!persona) {
    return (
      <div className="hc-box p-4 text-sm">
        <Link href="/" className="hc-link">
          Connect your wallet and claim a token
        </Link>{" "}
        to reply to this thread.
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
          <span className="text-sm" style={{ color: "#a12b2b" }}>
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
