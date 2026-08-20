"use client";

// Shared owned/claimed token-id cache for one connected address - the fix
// for a real bug reported live: WalletHeaderWidget used to fetch its own
// ownedTokenCount/myClaimedCount once per address in an isolated effect,
// with nothing to tell it to refetch when app/collection/page.tsx activates
// tokens. The header stayed stuck on "Activate NFTs" (and skipped the
// avatar state entirely, since hasUnactivatedTokens is checked first)
// forever after - not just until the next reload, since a stale count in
// this cache would keep coming back stale on reload too if the refetch
// itself raced the claim write. Every component that reads these counts
// now shares one cache, and every component that CHANGES claim status
// calls markTokensClaimed/refreshMyTokens so the whole app - not just the
// page that did the claiming - sees it immediately. Same
// useSyncExternalStore + module-level cache + notify() pattern already
// used by lib/usePersona.ts, for the same reason: this is genuinely
// external, cross-component state, not local to one component tree.
import { useCallback, useEffect, useSyncExternalStore } from "react";

interface MyTokens {
  ownedTokenIds: string[];
  claimedTokenIds: string[];
}

const listeners = new Set<() => void>();
const cache = new Map<string, MyTokens>();
const inflight = new Map<string, Promise<void>>();

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Throws on a failed fetch instead of quietly resolving to an empty
// tokenIds list - a real bug reported live: /api/wallet-tokens does a live
// on-chain scan that can transiently fail (RPC hiccup, timeout), and
// swallowing that into `{ tokenIds: [] }` used to write a false "owns
// zero tokens" result straight into the shared cache below, flashing the
// header's avatar button into its "no HOODCHAN in this wallet" gear icon
// even though the wallet still holds everything. Letting it throw means
// refreshMyTokens (below) can tell "this fetch genuinely came back empty"
// apart from "this fetch failed" and only ever trust the former.
async function doFetch(address: string): Promise<MyTokens> {
  const [ownedRes, claimedRes] = await Promise.all([
    fetch(`/api/wallet-tokens?${new URLSearchParams({ address })}`),
    fetch(`/api/persona/mine?${new URLSearchParams({ address })}`),
  ]);
  if (!ownedRes.ok) {
    throw new Error(`wallet-tokens fetch failed (${ownedRes.status})`);
  }
  if (!claimedRes.ok) {
    throw new Error(`persona/mine fetch failed (${claimedRes.status})`);
  }
  const [ownedBody, claimedBody] = await Promise.all([
    ownedRes.json(),
    claimedRes.json(),
  ]);
  return {
    ownedTokenIds: Array.isArray(ownedBody.tokenIds) ? ownedBody.tokenIds : [],
    claimedTokenIds: Array.isArray(claimedBody.tokenIds)
      ? claimedBody.tokenIds
      : [],
  };
}

// Re-fetches from the server and replaces the cached entry for `address` -
// call after any action that changes claim status. De-duped: a second call
// while one's already in flight for the same address just joins it, rather
// than firing a redundant request. On failure, deliberately leaves
// whatever's already cached alone (see doFetch's comment above) rather
// than overwriting good data with a wrong "zero tokens" result - a first-
// ever load that fails retries once after a few seconds instead of
// leaving the UI stuck.
export async function refreshMyTokens(address: string): Promise<void> {
  const existing = inflight.get(address);
  if (existing) return existing;
  const hadCache = cache.has(address);
  const promise = doFetch(address)
    .then((result) => {
      cache.set(address, result);
      notify();
    })
    .catch((err) => {
      console.error(`useMyTokens: refresh failed for ${address}`, err);
      if (!hadCache) {
        setTimeout(() => {
          if (!cache.has(address)) refreshMyTokens(address);
        }, 3000);
      }
    })
    .finally(() => {
      inflight.delete(address);
    });
  inflight.set(address, promise);
  return promise;
}

// Optimistic local update - marks tokenIds as claimed in the shared cache
// immediately, no round trip, so the header's button/avatar updates in the
// same tick a claim/activate call succeeds instead of waiting on a fresh
// fetch. refreshMyTokens should still be called afterward (fire-and-forget
// is fine) to reconcile with the server's real state.
export function markTokensClaimed(address: string, tokenIds: string[]): void {
  const current = cache.get(address);
  const claimedSet = new Set(current?.claimedTokenIds ?? []);
  tokenIds.forEach((id) => claimedSet.add(id));
  cache.set(address, {
    ownedTokenIds: current?.ownedTokenIds ?? [],
    claimedTokenIds: [...claimedSet],
  });
  notify();
}

export function useMyTokens(address: string | null) {
  const raw = useSyncExternalStore(
    subscribe,
    () => (address ? (cache.get(address) ?? null) : null),
    () => null,
  );

  useEffect(() => {
    if (!address) return;
    if (!cache.has(address)) refreshMyTokens(address);
  }, [address]);

  const refresh = useCallback(() => {
    if (!address) return Promise.resolve();
    return refreshMyTokens(address);
  }, [address]);

  return {
    ownedTokenIds: raw?.ownedTokenIds ?? null,
    claimedTokenIds: raw?.claimedTokenIds ?? null,
    ownedTokenCount: raw?.ownedTokenIds?.length ?? null,
    myClaimedCount: raw?.claimedTokenIds?.length ?? null,
    refresh,
  };
}
