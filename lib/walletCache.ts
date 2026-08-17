// Client-side cache of "which HOODCHAN tokens has this address ever held" -
// exists because fetchWalletTokensOnChain's first step is an eth_getLogs
// scan of the full contract history, and without this every page
// refresh/reconnect re-ran that full-history scan from scratch. localStorage
// (not sessionStorage): this is public on-chain ownership data, not a
// signed identity claim, so persisting it across browser restarts is
// strictly a win, not a scope-creep risk the way persisting a persona claim
// would be.
const CACHE_PREFIX = "h00dchan:wallet-scan:";

export interface WalletScanCache {
  tokenIds: string[];
  lastScannedBlock: string; // hex block number, see lib/chain.ts's readBlockNumber
}

export function readWalletCache(address: string): WalletScanCache | null {
  try {
    const raw = window.localStorage.getItem(
      CACHE_PREFIX + address.toLowerCase(),
    );
    return raw ? (JSON.parse(raw) as WalletScanCache) : null;
  } catch {
    return null;
  }
}

// Swallows write failures (quota exceeded, private-mode storage
// restrictions) - this cache is a pure optimization, never a source of
// truth (fetchWalletTokensOnChain always re-verifies ownership live), so
// failing to write it should degrade to "scan from scratch next time," not
// break the page.
export function writeWalletCache(
  address: string,
  cache: WalletScanCache,
): void {
  try {
    window.localStorage.setItem(
      CACHE_PREFIX + address.toLowerCase(),
      JSON.stringify(cache),
    );
  } catch {
    // best-effort only
  }
}

function nextBlockHex(blockHex: string): string {
  return `0x${(BigInt(blockHex) + BigInt(1)).toString(16)}`;
}

export { nextBlockHex };

// --- Render cache -----------------------------------------------------------
//
// The cache above only remembers WHICH token IDs an address holds and how
// far the on-chain scan got - it was never enough on its own to render
// anything, so every single page load (even with a warm scan cache) still
// had to wait on a real round trip - metadata for every token, claimed
// status for every token, TBA info for every token - before showing
// anything but a loading state. That's the "why does it scan every time I
// open my wallet" complaint: it wasn't re-scanning the chain every time,
// but it WAS re-fetching everything needed to draw the grid every time,
// with nothing shown until that finished.
//
// This cache stores the actual last-rendered result, so a repeat visit can
// paint instantly from it while the real fetch (still using the scan cache
// above, still self-healing, still re-verifying ownership live) runs
// silently in the background and swaps in anything that actually changed.
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
    // best-effort only, same reasoning as writeWalletCache above.
  }
}
