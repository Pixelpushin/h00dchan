"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { useActivePersona } from "@/lib/usePersona";
import { postJsonAsPersona } from "@/lib/postAsPersona";
import type { Thread, Post } from "@/lib/store";

export function NewThreadForm() {
  const router = useRouter();
  const { persona, reauthorize } = useActivePersona();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // useActivePersona's server snapshot is always null, matching this
  // "not claimed" branch - so SSR and the first client paint always agree,
  // and it upgrades to the form below shortly after mount if a persona is
  // actually present (see lib/usePersona.ts).
  if (!persona) {
    return (
      <div className="hc-box p-4 text-sm">
        <Link href="/" className="hc-link">
          Connect your wallet and claim a token
        </Link>{" "}
        to start a thread.
      </div>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!subject.trim() || !body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await postJsonAsPersona<{ thread: Thread; post: Post }>(
        "/api/threads",
        { subject: subject.trim(), body: body.trim() },
        persona,
        reauthorize,
      );
      setSubject("");
      setBody("");
      router.push(`/board/${result.thread.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to post thread.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="hc-box p-4 flex flex-col gap-2">
      <div className="hc-post-tokenid text-sm">
        Posting as Anon #{persona.tokenId}
      </div>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        maxLength={100}
        className="hc-form-input"
        disabled={submitting}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Comment (lines starting with > are greentext)"
        rows={4}
        maxLength={4000}
        className="hc-form-input"
        disabled={submitting}
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="hc-button">
          {submitting ? "Posting..." : "New Thread"}
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
