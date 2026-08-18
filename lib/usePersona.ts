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

export function useActivePersona() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const persona = useMemo<PersonaClaim | null>(() => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersonaClaim;
    } catch {
      return null;
    }
  }, [raw]);

  const savePersona = useCallback((next: PersonaClaim) => {
    window.sessionStorage.setItem(PERSONA_SESSION_KEY, JSON.stringify(next));
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
  // wallet has already claimed - signs a fresh auth message for it, same
  // as reauthorize above, but for an arbitrary target instead of
  // refreshing the current one. Only needs a tokenId, not a full
  // TokenMetadata object, specifically so callers that don't already have
  // the whole token grid loaded (WalletHeaderWidget's quick-switch list,
  // which lives on every page, not just home) can use it without
  // duplicating HomeClient's own claim-signing flow.
  const switchPersona = useCallback(
    async (tokenId: string): Promise<PersonaClaim> => {
      const account = await connectWallet();
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

  return { persona, savePersona, clearPersona, reauthorize, switchPersona };
}
