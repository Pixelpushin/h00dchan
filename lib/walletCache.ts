// Client-side cache of an address's last-rendered wallet grid (resolved
// token metadata, TBA/wallet info, claimed status) - lets a repeat visit
// paint instantly instead of waiting on a real round trip (metadata for
// every token, claimed status for every token, TBA info for every token)
// before showing anything but a loading state. HomeClient.tsx's loadTokens
// hydrates from this immediately, then kicks off a real background fetch
// (always a full on-chain scan now - see loadTokens's own comment for why
// an earlier incremental-scan version was removed after repeatedly
// self-healing around the same root problem) that silently swaps in
// anything that actually changed once it resolves.
//
// Deliberately untyped beyond "plausible JSON shape" here rather than
// importing HomeClient's TokenMetadata/TbaInfo types - this module has no
// other reason to depend on either, and the cached value is never trusted
// without a background re-fetch anyway, so a stale/malformed shape just
// means one call site gets slightly wrong types for a moment, not a real
// correctness issue.
const RENDER_CACHE_PREFIX = "h00dchan:wallet-render:";

export interface WalletRenderCache {
  tokens: unknown[];
  wallets: Record<string, unknown>;
  claimedTokens: Record<string, boolean>;
}

export function readWalletRenderCache(
  address: string,
): WalletRenderCache | null {
  try {
    const raw = window.localStorage.getItem(
      RENDER_CACHE_PREFIX + address.toLowerCase(),
    );
    return raw ? (JSON.parse(raw) as WalletRenderCache) : null;
  } catch {
    return null;
  }
}

// Swallows write failures (quota exceeded, private-mode storage
// restrictions) - this cache is a pure optimization, never a source of
// truth, so failing to write it should degrade to "loading state on next
// visit," not break the page.
export function writeWalletRenderCache(
  address: string,
  cache: WalletRenderCache,
): void {
  try {
    window.localStorage.setItem(
      RENDER_CACHE_PREFIX + address.toLowerCase(),
      JSON.stringify(cache),
    );
  } catch {
    // best-effort only
  }
}
