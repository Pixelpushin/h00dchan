"use client";

// Reads/writes the active "posting as this Anon" claim from sessionStorage.
// Built on useSyncExternalStore - the same primitive app/page.tsx already
// uses for window.ethereum - rather than a useEffect+setState, for the
// same reason: sessionStorage is genuinely external, mutable browser
// state, unavailable during SSR. getServerSnapshot returns null (matching
// what SSR renders: "no persona known yet"), getSnapshot reads the real
// value once mounted, and there's no risk of the hydration-mismatch class
// of bug this app already hit once (a window-dependent value read directly
// in render).
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { connectWallet, signMessage } from "@/lib/wallet";
import {
  buildAuthMessage,
  PERSONA_MAX_AGE_MS,
  PERSONA_SESSION_KEY,
  type PersonaClaim,
} from "@/lib/persona";

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return window.sessionStorage.getItem(PERSONA_SESSION_KEY);
}

function getServerSnapshot(): string | null {
  return null;
}

// Recently-used personas, most-recent-first, deduped by tokenId - both the
// source for the header widget's quick-switch order and the cache that
// lets switchPersona skip re-signing for an anon you already signed for
// recently (see switchPersona below). Capped well above what any session
// actually needs, just to keep sessionStorage bounded.
const PERSONA_HISTORY_KEY = "h00dchan:persona-history";
const HISTORY_LIMIT = 12;

function getHistorySnapshot(): string | null {
  return window.sessionStorage.getItem(PERSONA_HISTORY_KEY);
}

function readHistory(): PersonaClaim[] {
  const raw = getHistorySnapshot();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PersonaClaim[]) : [];
  } catch {
    return [];
  }
}

function writeHistory(next: PersonaClaim[]) {
  window.sessionStorage.setItem(PERSONA_HISTORY_KEY, JSON.stringify(next));
}

// A cached claim is only reusable without a fresh signature if it's still
// within the same freshness window the server itself enforces
// (PERSONA_MAX_AGE_MS) - reusing it right up to that edge and then having
// the very next post rejected server-side would be a worse experience than
// just signing again a little earlier.
function isFreshClaim(claim: PersonaClaim): boolean {
  return Date.now() - Date.parse(claim.issuedAt) < PERSONA_MAX_AGE_MS;
}

export function useActivePersona() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const historyRaw = useSyncExternalStore(
    subscribe,
    getHistorySnapshot,
    getServerSnapshot,
  );

  const persona = useMemo<PersonaClaim | null>(() => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersonaClaim;
    } catch {
      return null;
    }
  }, [raw]);

  const personaHistory = useMemo<PersonaClaim[]>(() => {
    if (!historyRaw) return [];
    try {
      const parsed = JSON.parse(historyRaw);
      return Array.isArray(parsed) ? (parsed as PersonaClaim[]) : [];
    } catch {
      return [];
    }
  }, [historyRaw]);

  const savePersona = useCallback((next: PersonaClaim) => {
    window.sessionStorage.setItem(PERSONA_SESSION_KEY, JSON.stringify(next));
    const history = readHistory().filter((c) => c.tokenId !== next.tokenId);
    history.unshift(next);
    writeHistory(history.slice(0, HISTORY_LIMIT));
    notify();
  }, []);

  const clearPersona = useCallback(() => {
    window.sessionStorage.removeItem(PERSONA_SESSION_KEY);
    notify();
  }, []);

  // Signs a brand-new claim for the same token+address without sending the
  // user back to the home page - used when the server rejects a post
  // because the previous signature aged past the 15-minute window. Fails
  // loudly (rather than silently posting as the wrong identity) if the
  // wallet's currently-connected account no longer matches the persona.
  const reauthorize = useCallback(async (): Promise<PersonaClaim> => {
    if (!persona) throw new Error("No active persona to refresh.");
    const account = await connectWallet();
    if (account.toLowerCase() !== persona.address.toLowerCase()) {
      throw new Error(
        "Connected wallet address changed - reclaim your token from the home page.",
      );
    }
    const issuedAt = new Date().toISOString();
    const message = buildAuthMessage(persona.tokenId, account, issuedAt);
    const signature = await signMessage(account, message);
    const next: PersonaClaim = {
      tokenId: persona.tokenId,
      address: account,
      signature,
      issuedAt,
    };
    savePersona(next);
    return next;
  }, [persona, savePersona]);

  // Switches the active posting identity to any tokenId the connected
  // wallet has already claimed. Previously this always signed a fresh
  // message - reported live as the switch itself being annoying when
  // bouncing between a few anons you'd just used. Now checks the recent-
  // history cache first: a signature for this exact tokenId+address made
  // within the last PERSONA_MAX_AGE_MS is exactly as valid to the server
  // as a brand new one (the server doesn't care when within that window a
  // signature was produced), so reuse it and skip the wallet prompt
  // entirely. Only signs fresh when there's no usable cached claim - never
  // reused past the server's own freshness window, so this never trades
  // away the "you no longer hold this token" recency guarantee the 15-
  // minute expiry exists for.
  const switchPersona = useCallback(
    async (tokenId: string): Promise<PersonaClaim> => {
      const account = await connectWallet();
      const cached = readHistory().find(
        (c) =>
          c.tokenId === tokenId &&
          c.address.toLowerCase() === account.toLowerCase() &&
          isFreshClaim(c),
      );
      if (cached) {
        savePersona(cached);
        return cached;
      }
      const issuedAt = new Date().toISOString();
      const message = buildAuthMessage(tokenId, account, issuedAt);
      const signature = await signMessage(account, message);
      const next: PersonaClaim = {
        tokenId,
        address: account,
        signature,
        issuedAt,
      };
      savePersona(next);
      return next;
    },
    [savePersona],
  );

  return {
    persona,
    personaHistory,
    savePersona,
    clearPersona,
    reauthorize,
    switchPersona,
  };
}
