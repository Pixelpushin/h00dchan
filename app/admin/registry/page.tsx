"use client";

// Moderation for CircleJerkFinance - entries go live immediately on
// submission (the eligibility bar is the real gate), this page just lets
// an admin remove garbage/scam listings after the fact. Same wallet-
// whitelist admin session as app/admin/ads/page.tsx.
import { useCallback, useEffect, useState } from "react";
import type { RegistryEntry } from "@/lib/registryStore";
import { useAdminSession, authHeaders } from "@/lib/useAdminSession";

export default function AdminRegistryPage() {
  const { session, connecting, connectError, connect, clearSession } =
    useAdminSession();
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/registry");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) queueMicrotask(() => loadEntries());
  }, [session, loadEntries]);

  const handleConnect = async () => {
    await connect();
  };

  const handleRemove = async (id: string) => {
    if (!session) return;
    setActingId(id);
    try {
      const res = await fetch(`/api/admin/registry/${id}`, {
        method: "DELETE",
        headers: authHeaders(session),
      });
      if (res.status === 401) {
        clearSession();
        throw new Error("Not authorized as admin for this wallet.");
      }
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setEntries((current) => current.filter((entry) => entry.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setActingId(null);
    }
  };

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="hc-box flex flex-col gap-3 p-4 w-full max-w-sm text-center">
          <p className="hc-thread-meta text-xs">
            Connect and sign with a whitelisted admin wallet.
          </p>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="hc-button"
          >
            {connecting ? "Connecting..." : "Connect Wallet"}
          </button>
          {connectError && (
            <p className="text-sm" style={{ color: "var(--hc-danger)" }}>
              {connectError}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="hc-title text-xl">CircleJerkFinance registry</h1>
        <button
          onClick={() => loadEntries()}
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
      {!loading && entries.length === 0 && !error && (
        <p className="hc-thread-meta text-center">Nothing listed.</p>
      )}

      <div className="flex flex-col gap-3">
        {entries.map((entry) => (
          <div key={entry.id} className="hc-box p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="hc-thread-subject text-sm">{entry.name}</span>
              <span className="hc-thread-meta text-xs">
                {entry.kind === "nft" ? "NFT collection" : "ERC-20 token"}
              </span>
              {entry.sponsored && (
                <span className="hc-thread-meta text-xs">core-vouched</span>
              )}
            </div>
            <div className="hc-thread-meta text-xs break-all">
              {entry.contractAddress}
            </div>
            <div className="hc-thread-meta text-xs break-all">{entry.url}</div>
            <div className="hc-thread-meta text-xs">
              listed by Anon #{entry.submitterTokenId} ({entry.submitterAddress}
              )
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => handleRemove(entry.id)}
                disabled={actingId === entry.id}
                className="hc-button-ghost hc-button text-xs"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
