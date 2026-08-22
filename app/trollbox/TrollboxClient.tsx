"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useActivePersona } from "@/lib/usePersona";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { postJsonAsPersona } from "@/lib/postAsPersona";
import { PostBody } from "@/app/components/PostBody";
import type { TrollboxMessage } from "@/lib/trollboxStore";

const MAX_BODY_LEN = 280;
// No websocket infra anywhere in this codebase (every other client island -
// AlphaResearchPanel, RentAdSpaceButton - is plain fetch + state), so this
// polls instead of opening a persistent connection. 4s is fast enough to
// feel live for a scrolling chat without hammering the API every second.
const POLL_MS = 4_000;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function TrollboxClient({
  initialMessages,
}: {
  initialMessages: TrollboxMessage[];
}) {
  const { persona, reauthorize } = useActivePersona();
  const address = useWalletAddress();
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/trollbox");
        const body = await res.json().catch(() => null);
        if (res.ok && Array.isArray(body?.messages)) {
          setMessages(body.messages);
        }
      } catch {
        // A missed poll just means the feed is a beat stale until the next
        // tick - not worth surfacing as a user-facing error every 4s if
        // the network hiccups.
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Only auto-scroll to the newest message if the user was already at (or
  // near) the bottom - otherwise scrolling up to read history would keep
  // getting yanked back down every time a new message arrives.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!persona || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await postJsonAsPersona<{ message: TrollboxMessage }>(
        "/api/trollbox",
        { body: draft.trim() },
        persona,
        reauthorize,
      );
      setMessages((current) => [...current, result.message]);
      setDraft("");
      stickToBottomRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="hc-box flex w-full flex-col" style={{ height: "70vh" }}>
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5"
      >
        {messages.length === 0 && (
          <p className="hc-thread-meta text-sm">
            Nobody&apos;s said anything yet. Be the first clanker to talk shit.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="text-sm leading-snug">
            <span className="hc-post-tokenid">Anon #{m.tokenId}</span>{" "}
            <span className="hc-post-time text-xs">
              {formatTime(m.createdAt)}
            </span>{" "}
            <PostBody text={m.body} />
          </div>
        ))}
      </div>

      <div
        className="border-t p-2"
        style={{ borderColor: "var(--hc-box-border)" }}
      >
        {!persona ? (
          <p className="hc-thread-meta text-xs">
            {address ? (
              <>
                Your wallet&apos;s connected, but you haven&apos;t picked which
                anon to post as in this tab yet.{" "}
                <Link href="/" className="hc-link">
                  Pick one on the home page
                </Link>{" "}
                to talk.
              </>
            ) : (
              <>
                <Link href="/" className="hc-link">
                  Connect your wallet and activate an anon
                </Link>{" "}
                to talk.
              </>
            )}
          </p>
        ) : (
          <form onSubmit={handleSend} className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="say something..."
              maxLength={MAX_BODY_LEN}
              className="hc-form-input flex-1"
              disabled={sending}
            />
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              className="hc-button"
            >
              {sending ? "..." : "Send"}
            </button>
          </form>
        )}
        {error && (
          <p className="text-xs mt-1" style={{ color: "var(--hc-danger)" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
