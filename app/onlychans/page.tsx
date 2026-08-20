"use client";

// onlyChans - holder-gated feed where only the AI posts (see lib/
// onlychansConfig.ts for the "uncanny AI art fail" prompt/caption pools
// this is satirizing). Styled to match the real board's post format
// exactly (.hc-post / .hc-post-header, same as app/board/[threadId]) -
// this is a board like any other on the site, just one where every poster
// is the same bot and nothing it posts is real. The generation prompt is
// never shown; each post's caption is a separate, deliberately unhinged
// OnlyFans-thirst-trap-style line (lib/onlychansConfig.ts's CAPTION_POOL),
// not a description of the image.
import { useCallback, useEffect, useRef, useState } from "react";
import { useHolderSession, holderAuthHeaders } from "@/lib/useHolderSession";
import { useWalletAddress } from "@/lib/useWalletAddress";
import type { OnlyChanPost } from "@/lib/onlychansStore";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function OnlyChanPostCard({ post }: { post: OnlyChanPost }) {
  return (
    <div className="hc-post hc-post-op">
      <div className="hc-post-header">
        <span className="hc-post-name">Anonymous</span>{" "}
        <span className="hc-post-tokenid">onlyChans bot</span>{" "}
        <span
          className="hc-post-ai-badge"
          title="Every post here is AI-generated"
        >
          (AI)
        </span>{" "}
        <span className="hc-post-time">{formatTime(post.createdAt)}</span>{" "}
        <span className="hc-post-num">No.{post.id}</span>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={post.imageUrl}
          alt=""
          className="hc-post-image object-cover w-40 h-40 shrink-0"
        />
        <div className="flex-1">
          <p className="hc-post-body">{post.caption || "..."}</p>
        </div>
      </div>
    </div>
  );
}

export default function OnlyChansPage() {
  const { session, connecting, connectError, connect, clearSession } =
    useHolderSession();
  const address = useWalletAddress();
  const [posts, setPosts] = useState<OnlyChanPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFeed = useCallback(
    async (activeSession: NonNullable<typeof session>) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/onlychans/feed", {
          headers: holderAuthHeaders(activeSession),
        });
        if (res.status === 401) {
          const data = await res.json().catch(() => ({}));
          clearSession();
          throw new Error(data.error ?? "Not authorized.");
        }
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const data = await res.json();
        setPosts(data.posts ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        setLoading(false);
      }
    },
    [clearSession],
  );

  useEffect(() => {
    if (!session) return;
    queueMicrotask(() => loadFeed(session));
  }, [session, loadFeed]);

  const handleConnect = async () => {
    const newSession = await connect();
    if (newSession) await loadFeed(newSession);
  };

  // If a wallet is already connected site-wide (e.g. via the header widget
  // or the homepage's unblurred onlyChans preview, which only checks
  // useWalletAddress()), this page's own holder-signed session still
  // doesn't exist yet in this tab - reported live as "I'm already logged
  // in with an NFT but I see a Connect Wallet button and no posts." Only
  // a signature is actually missing at that point (connectWallet() itself
  // resolves instantly for an already-connected wallet, no modal), so
  // auto-trigger that signature prompt instead of making them click a
  // button that says "Connect Wallet" while they're already connected.
  // One-shot via the ref: if the user dismisses the signature request,
  // don't loop back and immediately re-prompt them.
  const autoAttempted = useRef(false);
  useEffect(() => {
    if (!address || session || connecting || autoAttempted.current) return;
    autoAttempted.current = true;
    handleConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, session, connecting]);

  if (!session) {
    const alreadyConnected = Boolean(address);
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 gap-4 text-center">
        <h1 className="hc-title text-2xl">onlyChans</h1>
        <p className="hc-thread-meta text-sm max-w-sm">
          Nobody posts here but the AI. Hold a HOODCHAN anon or any CHAN to see
          what it&apos;s been generating.
        </p>
        <div className="hc-box flex flex-col gap-3 p-4 w-full max-w-sm">
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="hc-button"
          >
            {connecting
              ? "Check your wallet for a signature request..."
              : alreadyConnected
                ? "Sign in to view"
                : "Connect Wallet"}
          </button>
          {(connectError || error) && (
            <p className="text-sm" style={{ color: "var(--hc-danger)" }}>
              {connectError ?? error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <div className="flex items-center justify-between">
          <h1 className="hc-title text-xl">/oc/ - onlyChans</h1>
          <button
            onClick={() => loadFeed(session)}
            disabled={loading}
            className="hc-button-ghost hc-button text-xs"
          >
            Refresh
          </button>
        </div>

        {loading && <p className="text-center">Loading...</p>}
        {error && (
          <p
            className="text-sm text-center"
            style={{ color: "var(--hc-danger)" }}
          >
            {error}
          </p>
        )}
        {!loading && posts.length === 0 && !error && (
          <p className="hc-thread-meta text-center">
            Nothing posted yet - check back after the next generation run.
          </p>
        )}

        <div className="flex flex-col gap-3">
          {posts.map((post) => (
            <OnlyChanPostCard key={post.id} post={post} />
          ))}
        </div>
      </main>
    </div>
  );
}
