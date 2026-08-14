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
