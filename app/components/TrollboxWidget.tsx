"use client";

// Persistent, site-wide troll box - fixed to the bottom-right corner of
// every page in THIS app (not fight./fuck. - those are entirely separate
// repos/deployments, so mounting this in the root layout here can't reach
// them regardless). Lives in the root layout (see app/components/
// Trollbox.tsx), so its open/collapsed state survives client-side
// navigation for free - Next's App Router keeps a layout's component tree
// mounted across route changes within the same layout, no
// sessionStorage/localStorage needed just to remember the toggle.
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
  });
}

export function TrollboxWidget({
  initialMessages,
}: {
  initialMessages: TrollboxMessage[];
}) {
  const { persona, reauthorize } = useActivePersona();
  const address = useWalletAddress();
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/trollbox");
        const body = await res.json().catch(() => null);
        if (res.ok && Array.isArray(body?.messages)) {
          const fresh: TrollboxMessage[] = body.messages;
          setMessages((current) => {
            if (!open && fresh.length > current.length) {
              setUnseenCount((n) => n + (fresh.length - current.length));
            }
            return fresh;
          });
        }
      } catch {
        // A missed poll just means the feed is a beat stale until the next
        // tick - not worth surfacing as a user-facing error every 4s if
        // the network hiccups.
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [open]);

  // Only auto-scroll to the newest message if the user was already at (or
  // near) the bottom - otherwise scrolling up to read history would keep
  // getting yanked back down every time a new message arrives.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, open]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const handleOpen = () => {
    setOpen(true);
    setUnseenCount(0);
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

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        className="hc-button fixed bottom-3 right-3 z-40 shadow-md"
      >
        Trollbox{unseenCount > 0 ? ` (${unseenCount})` : ""}
      </button>
    );
  }

  return (
    <div
      className="hc-box fixed bottom-3 right-3 z-40 flex w-80 flex-col shadow-md"
      style={{ height: "22rem" }}
    >
      <div
        className="flex items-center justify-between border-b px-2 py-1.5"
        style={{ borderColor: "var(--hc-box-border)" }}
      >
        <span className="hc-title text-sm">Trollbox</span>
        <button
          onClick={() => setOpen(false)}
          className="hc-infobox-close"
          style={{ color: "var(--hc-maroon)" }}
        >
          [x]
        </button>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2 flex flex-col gap-1"
      >
        {messages.length === 0 && (
          <p className="hc-thread-meta text-xs">
            Nobody&apos;s said anything yet. Be the first clanker to talk shit.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="text-xs leading-snug">
            <span className="hc-post-tokenid">
              {m.source === "x-bridge" ? "X Chat" : `Anon #${m.tokenId}`}
            </span>{" "}
            <span className="hc-post-time">{formatTime(m.createdAt)}</span>{" "}
            <PostBody text={m.body} />
          </div>
        ))}
      </div>

      <div
        className="border-t p-1.5"
        style={{ borderColor: "var(--hc-box-border)" }}
      >
        {!persona ? (
          <p className="hc-thread-meta text-xs">
            {address ? (
              <>
                <Link href="/" className="hc-link">
                  Pick an anon
                </Link>{" "}
                on the home page to talk.
              </>
            ) : (
              <>
                <Link href="/" className="hc-link">
                  Connect your wallet
                </Link>{" "}
                to talk.
              </>
            )}
          </p>
        ) : (
          <form onSubmit={handleSend} className="flex gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="say something..."
              maxLength={MAX_BODY_LEN}
              className="hc-form-input flex-1 text-xs"
              disabled={sending}
            />
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              className="hc-button text-xs"
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
