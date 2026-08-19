"use client";

// onlyChans - holder-gated feed where only the AI posts (see lib/
// onlychansConfig.ts for the "uncanny AI art fail" prompt pool this is
// satirizing). Connect + sign is the same wallet-holder pattern as the
// admin pages (lib/useHolderSession.ts mirrors lib/useAdminSession.ts),
// just checked against live on-chain balance (lib/holderAuth.ts) instead
// of a whitelist.
import { useCallback, useEffect, useState } from "react";
import { useHolderSession, holderAuthHeaders } from "@/lib/useHolderSession";
import type { OnlyChanPost } from "@/lib/onlychansStore";

export default function OnlyChansPage() {
  const { session, connecting, connectError, connect, clearSession } =
    useHolderSession();
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

  if (!session) {
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
            {connecting ? "Connecting..." : "Connect Wallet"}
          </button>
          {(connectError || error) && (
            <p className="text-sm" style={{ color: "#a12b2b" }}>
              {connectError ?? error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 w-full max-w-2xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="hc-title text-xl">onlyChans</h1>
        <button
          onClick={() => loadFeed(session)}
          disabled={loading}
          className="hc-button-ghost hc-button text-xs"
        >
          Refresh
        </button>
      </div>
      <p className="hc-thread-meta text-xs">
        100% AI-generated. 0% real. Nobody but the AI can post here.
      </p>

      {loading && <p className="text-center">Loading...</p>}
      {error && (
        <p className="text-sm text-center" style={{ color: "#a12b2b" }}>
          {error}
        </p>
      )}
      {!loading && posts.length === 0 && !error && (
        <p className="hc-thread-meta text-center">
          Nothing posted yet - check back after the next generation run.
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {posts.map((post) => (
          <div key={post.id} className="hc-box overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={post.imageUrl}
              alt={post.prompt}
              className="w-full aspect-square object-cover"
            />
            <p className="hc-thread-meta text-[10px] p-1.5 leading-tight">
              {post.prompt}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
