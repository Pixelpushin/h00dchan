"use client";

// Wallet-holder session for onlyChans - same connect+sign+session shape as
// lib/useAdminSession.ts (including the getSnapshot referential-stability
// fix that file's own comment documents; see there for why it matters),
// just against the holder message/headers instead of the admin ones.
import { useCallback, useState, useSyncExternalStore } from "react";
import { connectWallet, signMessage } from "@/lib/wallet";
import {
  buildHolderAuthMessage,
  HOLDER_SESSION_MAX_AGE_MS,
} from "@/lib/holderMessage";

export interface HolderSession {
  address: string;
  signature: string;
  issuedAt: string;
}

const SESSION_KEY = "h00dchan:holder-session";
const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

let cachedRaw: string | null = null;
let cachedSnapshot: HolderSession | null = null;

function getSnapshot(): HolderSession | null {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;

  if (!raw) {
    cachedSnapshot = null;
    return null;
  }
  try {
    const session = JSON.parse(raw) as HolderSession;
    cachedSnapshot =
      Date.now() - Date.parse(session.issuedAt) > HOLDER_SESSION_MAX_AGE_MS
        ? null
        : session;
  } catch {
    cachedSnapshot = null;
  }
  return cachedSnapshot;
}

function getServerSnapshot(): HolderSession | null {
  return null;
}

function writeSession(session: HolderSession | null) {
  if (session) {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    window.sessionStorage.removeItem(SESSION_KEY);
  }
  listeners.forEach((listener) => listener());
}

export function holderAuthHeaders(
  session: HolderSession,
): Record<string, string> {
  return {
    "x-holder-address": session.address,
    "x-holder-signature": session.signature,
    "x-holder-issued-at": session.issuedAt,
  };
}

export function useHolderSession() {
  const session = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = useCallback(async (): Promise<HolderSession | null> => {
    setConnecting(true);
    setConnectError(null);
    try {
      const address = await connectWallet();
      const issuedAt = new Date().toISOString();
      const message = buildHolderAuthMessage(address, issuedAt);
      const signature = await signMessage(address, message);
      const newSession: HolderSession = { address, signature, issuedAt };
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

  const clearSession = useCallback(() => writeSession(null), []);

  return { session, connecting, connectError, connect, clearSession };
}
