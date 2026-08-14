"use client";

// First admin UI page in this repo - every other admin action is
// curl-only (see app/api/admin/*), which works for text operations but not
// for visually reviewing ad creative, which is the entire point of manual
// review. Not a real auth system: prompts for the same shared
// H00DCHAN_CRON_SECRET the other admin routes already use, stores it in
// sessionStorage, sends it as the bearer token on every request - matches
// the existing single-shared-secret model, just gives it a UI.
import { useCallback, useState, useSyncExternalStore } from "react";
import type { AdSubmission } from "@/lib/adStore";

const SECRET_KEY = "h00dchan:admin-secret";
const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): string | null {
  return window.sessionStorage.getItem(SECRET_KEY);
}

function getServerSnapshot(): string | null {
  return null;
}

function writeSecret(value: string) {
  window.sessionStorage.setItem(SECRET_KEY, value);
  listeners.forEach((listener) => listener());
}

export default function AdminAdsPage() {
  // useSyncExternalStore, not useState+useEffect: reading sessionStorage
  // during an effect and then setState-ing is exactly the pattern that's
  // bitten this app before (see WhatIsHoodchan's useDismissed) - SSR has no
  // sessionStorage, so getServerSnapshot returns null (matching the "locked"
  // state below) and the real value only appears after the client mounts.
  const secret = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const [secretInput, setSecretInput] = useState("");
  const [pending, setPending] = useState<AdSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  // Triggered explicitly from handleUnlock (a real event handler) rather
  // than an effect reacting to `secret` changing - this page's only entry
  // point into the unlocked state is that one user action, so there's no
  // "secret changed out from under us" case an effect would need to cover.
  const loadPending = useCallback(async (activeSecret: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ads", {
        headers: { authorization: `Bearer ${activeSecret}` },
      });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setPending(data.pending ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleUnlock = (event: React.FormEvent) => {
    event.preventDefault();
    writeSecret(secretInput);
    loadPending(secretInput);
  };

  const handleAction = async (id: string, action: "approve" | "reject") => {
    if (!secret) return;
    setActingId(id);
    try {
      const res = await fetch(`/api/admin/ads/${id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
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

  if (!secret) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <form
          onSubmit={handleUnlock}
          className="hc-box flex flex-col gap-2 p-4 w-full max-w-sm"
        >
          <label className="hc-thread-meta text-xs">Admin secret</label>
          <input
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            className="hc-form-input"
          />
          <button type="submit" className="hc-button">
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <div className="flex items-center justify-between">
          <h1 className="hc-title text-xl">Pending ad submissions</h1>
          <button
            onClick={() => loadPending(secret)}
            disabled={loading}
            className="hc-button-ghost hc-button text-xs"
          >
            Refresh
          </button>
        </div>

        {loading && <p className="text-center">Loading...</p>}
        {error && (
          <p className="text-sm text-center" style={{ color: "#a12b2b" }}>
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
      </main>
    </div>
  );
}
