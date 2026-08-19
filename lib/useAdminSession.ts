"use client";

// Shared wallet-whitelist admin session, extracted out of app/admin/ads/
// page.tsx once a second admin page (Notes) needed the exact same connect+
// sign+session logic - duplicating it risked re-introducing the same real
// production bug this file's getSnapshot() had to be fixed for once
// already (Minified React error #185, "Maximum update depth exceeded" -
// see the comment on cachedRaw/cachedSnapshot below for the actual cause).
import { useCallback, useState, useSyncExternalStore } from "react";
import { connectWallet, signMessage } from "@/lib/wallet";
import {
  ADMIN_SESSION_MAX_AGE_MS,
  buildAdminAuthMessage,
} from "@/lib/adminMessage";

export interface AdminSession {
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
// production on the Ads page before this was extracted: JSON.parse(raw) on
// every call returned a fresh object even when sessionStorage hadn't
// changed, so it never compared equal). Caching the last-seen raw string
// and only re-parsing when it actually differs is the fix.
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

export function authHeaders(session: AdminSession): Record<string, string> {
  return {
    "x-admin-address": session.address,
    "x-admin-signature": session.signature,
    "x-admin-issued-at": session.issuedAt,
  };
}

export function useAdminSession() {
  // useSyncExternalStore, not useState+useEffect: reading sessionStorage
  // during an effect and then setState-ing is exactly the pattern that's
  // bitten this app before (see WhatIsHoodchan's useDismissed) - SSR has no
  // sessionStorage, so getServerSnapshot returns null (matching the
  // "locked" state every admin page renders first) and the real value only
  // appears after the client mounts.
  const session = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = useCallback(async (): Promise<AdminSession | null> => {
    setConnecting(true);
    setConnectError(null);
    try {
      const address = await connectWallet();
      const issuedAt = new Date().toISOString();
      const message = buildAdminAuthMessage(address, issuedAt);
      const signature = await signMessage(address, message);
      const newSession: AdminSession = { address, signature, issuedAt };
      writeSession(newSession);
      return newSession;
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Failed to connect wallet.",
      );
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  // Called on a 401 from any admin API call - the whitelist changed, or the
  // session genuinely expired between the client-side check and the
  // request landing. Drops back to the connect screen rather than showing
  // a confusing empty/broken page.
  const clearSession = useCallback(() => writeSession(null), []);

  return { session, connecting, connectError, connect, clearSession };
}
