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

export interface TbaInfo {
  address: string;
  activated: boolean;
}

interface MyTokens {
  ownedTokenIds: string[];
  claimedTokenIds: string[];
  wallets: Record<string, TbaInfo>;
  levels: Record<string, number>;
  nestedCounts: Record<string, number>;
  fetchedAt: number;
}

// This module-level cache has no browser-storage persistence (resets on a
// real page reload), but a client-side navigation within the same tab
// keeps it alive indefinitely - and the mount effect below used to only
// ever fetch when NOTHING was cached yet, never when what's cached is
// just stale. A cache entry populated once from a genuinely bad response
// (e.g. an RPC hiccup that made /api/wallet-tokens come back with an
// empty/partial claimedTokenIds - see the per-token-loop RPC fix this
// same session) would sit there and keep the header stuck on "Activate
// NFTs" for the rest of that tab's session, even after the real
// underlying data was already fixed - reported live as the header
// button "not knowing" the collection page's own grid was already
// showing everything activated. STALE_MS bounds how long a bad snapshot
// can persist before the next mount/reconnect self-heals it, without
// re-fetching this expensive endpoint on every single re-render.
const STALE_MS = 60_000;

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

// Both owned and claimed come from the SAME /api/wallet-tokens response -
// previously this cross-checked ownedTokenIds (from /api/wallet-tokens)
// against claimedTokenIds from a SEPARATE endpoint (/api/persona/mine, a
// Redis reverse index that trusts its stored claim record's address
// rather than re-confirming current on-chain ownership). Those two
// independently-computed "claimed" signals could legitimately disagree,
// reported live as the header staying stuck on "Activate NFTs" after a
// reload even though the collection page - which verifies claimed status
// via the same live isTokenClaimed() check /api/wallet-tokens now returns
// as claimedTokenIds - showed everything activated. One endpoint, one
// consistent-by-construction source of truth, also halves the requests
// this hook makes.
//
// Throws on a failed fetch instead of quietly resolving to an empty
// tokenIds list - /api/wallet-tokens does a live on-chain scan that can
// transiently fail (RPC hiccup, timeout), and swallowing that into
// `{ tokenIds: [] }` used to write a false "owns zero tokens" result
// straight into the shared cache below, flashing the header's avatar
// button into its "no HOODCHAN in this wallet" gear icon even though the
// wallet still holds everything. Letting it throw means refreshMyTokens
// (below) can tell "this fetch genuinely came back empty" apart from
// "this fetch failed" and only ever trust the former.
async function doFetch(address: string): Promise<MyTokens> {
  const res = await fetch(
    `/api/wallet-tokens?${new URLSearchParams({ address })}`,
  );
  if (!res.ok) {
    throw new Error(`wallet-tokens fetch failed (${res.status})`);
  }
  const body = await res.json();
  return {
    ownedTokenIds: Array.isArray(body.tokenIds) ? body.tokenIds : [],
    claimedTokenIds: Array.isArray(body.claimedTokenIds)
      ? body.claimedTokenIds
      : [],
    wallets: body.wallets ?? {},
    levels: body.levels ?? {},
    nestedCounts: body.nestedCounts ?? {},
    // Overwritten with the real fetch-completion time in refreshMyTokens's
    // .then() below (after the claimedTokenIds union is computed) - this
    // placeholder only exists so doFetch's return type is a complete
    // MyTokens.
    fetchedAt: Date.now(),
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
      // claimedTokenIds specifically is unioned with whatever was already
      // cached (scoped to tokens still actually owned), not replaced
      // outright like ownedTokenIds/wallets/levels/nestedCounts above it -
      // /api/wallet-tokens's own per-token loop can transiently fail to
      // resolve a token under RPC load, which silently drops it from this
      // response's claimedTokenIds even though it's genuinely still
      // claimed. A full replace here flips the header's button straight
      // back to "Activate NFTs" for someone who already activated
      // everything - reported live as it "keeps popping up over and
      // over." Safe to only ever add, never drop, a claimed id here: a
      // token that's truly no longer owned is filtered out via the
      // ownedTokenIds intersection below, so nothing stale lingers once
      // it actually leaves the wallet.
      const previouslyClaimed = cache.get(address)?.claimedTokenIds ?? [];
      const ownedSet = new Set(result.ownedTokenIds);
      const claimedSet = new Set(result.claimedTokenIds);
      previouslyClaimed.forEach((id) => {
        if (ownedSet.has(id)) claimedSet.add(id);
      });
      cache.set(address, {
        ...result,
        claimedTokenIds: [...claimedSet],
        fetchedAt: Date.now(),
      });
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
    wallets: current?.wallets ?? {},
    levels: current?.levels ?? {},
    nestedCounts: current?.nestedCounts ?? {},
    // Deliberately NOT Date.now() here - this is an optimistic local patch,
    // not a real fetch, so it shouldn't reset the staleness clock that
    // decides when the next real fetch is due. Falls back to "now" only
    // when there's no prior real fetch to inherit a timestamp from.
    fetchedAt: current?.fetchedAt ?? Date.now(),
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
    const cached = cache.get(address);
    if (!cached || Date.now() - cached.fetchedAt > STALE_MS) {
      refreshMyTokens(address);
    }
  }, [address]);

  // WalletHeaderWidget (this hook's main consumer) lives in the root
  // layout and never unmounts across client-side navigation - the mount
  // effect above only re-fires if `address` itself changes, so a long
  // session with a stable connected wallet would otherwise never re-check
  // staleness no matter how much time passes. This interval is what
  // actually makes STALE_MS mean anything for that common case, not just
  // for a fresh page load.
  useEffect(() => {
    if (!address) return;
    const id = setInterval(() => {
      const cached = cache.get(address);
      if (!cached || Date.now() - cached.fetchedAt > STALE_MS) {
        refreshMyTokens(address);
      }
    }, STALE_MS);
    return () => clearInterval(id);
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
    wallets: raw?.wallets ?? null,
    levels: raw?.levels ?? null,
    nestedCounts: raw?.nestedCounts ?? null,
    refresh,
  };
}
