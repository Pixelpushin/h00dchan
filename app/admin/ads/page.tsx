"use client";

// First admin UI page in this repo - every other admin action is
// curl-only (see app/api/admin/*), which works for text operations but not
// for visually reviewing ad creative, which is the entire point of manual
// review. Wallet-whitelist auth via lib/useAdminSession.ts (connect + sign,
// same personal_sign flow as claiming an anon) - replaces the old typed-
// shared-secret prompt, which meant anyone who ever saw the secret (or
// found it in a curl history, a screen share, etc) had permanent admin
// access with no way to revoke just them.
import { useCallback, useState } from "react";
import type { AdSubmission } from "@/lib/adStore";
import { useAdminSession, authHeaders } from "@/lib/useAdminSession";

export default function AdminAdsPage() {
  const { session, connecting, connectError, connect, clearSession } =
    useAdminSession();
  const [pending, setPending] = useState<AdSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const loadPending = useCallback(
    async (activeSession: NonNullable<typeof session>) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/ads", {
          headers: authHeaders(activeSession),
        });
        if (res.status === 401) {
          clearSession();
          throw new Error("Not authorized as admin for this wallet.");
        }
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const data = await res.json();
        setPending(data.pending ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        setLoading(false);
      }
    },
    [clearSession],
  );

  const handleConnect = async () => {
    const newSession = await connect();
    if (newSession) await loadPending(newSession);
  };

  const handleAction = async (id: string, action: "approve" | "reject") => {
    if (!session) return;
    setActingId(id);
    try {
      const res = await fetch(`/api/admin/ads/${id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(session),
        },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setPending((current) => current.filter((ad) => ad.id !== id));
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
        <h1 className="hc-title text-xl">Pending ad submissions</h1>
        <button
          onClick={() => loadPending(session)}
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
      {!loading && pending.length === 0 && !error && (
        <p className="hc-thread-meta text-center">Nothing pending.</p>
      )}

      <div className="flex flex-col gap-3">
        {pending.map((ad) => (
          <div
            key={ad.id}
            className="hc-box p-4 flex flex-col sm:flex-row gap-4"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ad.imageUrl}
              alt={ad.name}
              className="w-full sm:w-64 h-32 object-contain bg-black shrink-0"
            />
            <div className="flex flex-1 flex-col gap-1">
              <div className="hc-thread-subject">{ad.name}</div>
              <a
                href={ad.openseaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hc-link text-sm break-all"
              >
                {ad.openseaUrl}
              </a>
              <div className="hc-thread-meta text-xs break-all">
                submitter: {ad.submitterAddress}
              </div>
              <div className="hc-thread-meta text-xs break-all">
                tx: {ad.txHash} ({ad.tokenSymbol})
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => handleAction(ad.id, "approve")}
                  disabled={actingId === ad.id}
                  className="hc-button text-xs"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleAction(ad.id, "reject")}
                  disabled={actingId === ad.id}
                  className="hc-button-ghost hc-button text-xs"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
