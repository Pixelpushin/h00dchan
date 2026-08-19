"use client";

// First admin UI page in this repo - every other admin action is
// curl-only (see app/api/admin/*), which works for text operations but not
// for visually reviewing ad creative, which is the entire point of manual
// review. Wallet-whitelist auth: connect + sign a message (same
// personal_sign flow as claiming an anon, see lib/wallet.ts/lib/persona.ts)
// proving control of a whitelisted admin address (lib/adminAuth.ts) -
// replaces the old typed-shared-secret prompt, which meant anyone who ever
// saw the secret (or found it in a curl history, a screen share, etc) had
// permanent admin access with no way to revoke just them.
import { useCallback, useState, useSyncExternalStore } from "react";
import type { AdSubmission } from "@/lib/adStore";
import { connectWallet, signMessage } from "@/lib/wallet";
import {
  ADMIN_SESSION_MAX_AGE_MS,
  buildAdminAuthMessage,
} from "@/lib/adminMessage";

interface AdminSession {
  address: string;
  signature: string;
  issuedAt: string;
}

const SESSION_KEY = "h00dchan:admin-session";
const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

// useSyncExternalStore requires getSnapshot to return a REFERENTIALLY
// STABLE value when nothing has actually changed - React calls it on every
// render to check for tearing, and treats any new object reference as "the
// store changed," re-rendering again, forever (confirmed live in
// production: this exact bug shipped as a real Minified React error #185,
// "Maximum update depth exceeded" - the earlier version parsed a fresh
// object out of sessionStorage on every single call, so even an unchanged
// value never compared equal). Caching the last-seen raw string and only
// re-parsing when it actually differs is the fix - same reasoning as the
// original secret-based version being safe (a raw string primitive IS
// stable across calls when unchanged; JSON.parse(raw) on every call is
// not).
let cachedRaw: string | null = null;
let cachedSnapshot: AdminSession | null = null;

function getSnapshot(): AdminSession | null {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;

  if (!raw) {
    cachedSnapshot = null;
    return null;
  }
  try {
    const session = JSON.parse(raw) as AdminSession;
    // Expire client-side too (matches ADMIN_SESSION_MAX_AGE_MS server-side)
    // so a stale session shows the connect screen again instead of firing
    // requests that'll just 401.
    cachedSnapshot =
      Date.now() - Date.parse(session.issuedAt) > ADMIN_SESSION_MAX_AGE_MS
        ? null
        : session;
  } catch {
    cachedSnapshot = null;
  }
  return cachedSnapshot;
}

function getServerSnapshot(): AdminSession | null {
  return null;
}

function writeSession(session: AdminSession | null) {
  if (session) {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    window.sessionStorage.removeItem(SESSION_KEY);
  }
  listeners.forEach((listener) => listener());
}

function authHeaders(session: AdminSession): Record<string, string> {
  return {
    "x-admin-address": session.address,
    "x-admin-signature": session.signature,
    "x-admin-issued-at": session.issuedAt,
  };
}

export default function AdminAdsPage() {
  // useSyncExternalStore, not useState+useEffect: reading sessionStorage
  // during an effect and then setState-ing is exactly the pattern that's
  // bitten this app before (see WhatIsHoodchan's useDismissed) - SSR has no
  // sessionStorage, so getServerSnapshot returns null (matching the
  // "locked" state below) and the real value only appears after the
  // client mounts.
  const session = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pending, setPending] = useState<AdSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  // Triggered explicitly from handleConnect (a real event handler) rather
  // than an effect reacting to `session` changing - this page's only entry
  // point into the unlocked state is that one user action, so there's no
  // "session changed out from under us" case an effect would need to cover.
  const loadPending = useCallback(async (activeSession: AdminSession) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ads", {
        headers: authHeaders(activeSession),
      });
      if (res.status === 401) {
        // Whitelist changed, or the session genuinely expired between the
        // client-side check above and this request landing - drop back to
        // the connect screen rather than showing a confusing empty list.
        writeSession(null);
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
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const address = await connectWallet();
      const issuedAt = new Date().toISOString();
      const message = buildAdminAuthMessage(address, issuedAt);
      const signature = await signMessage(address, message);
      const newSession: AdminSession = { address, signature, issuedAt };
      writeSession(newSession);
      await loadPending(newSession);
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Failed to connect wallet.",
      );
    } finally {
      setConnecting(false);
    }
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
            <p className="text-sm" style={{ color: "#a12b2b" }}>
              {connectError}
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
