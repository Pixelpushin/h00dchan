// ENS name resolution for the wallet send form (app/components/WalletActionsPanel.tsx).
// Robinhood Chain (chain ID 4663, see lib/chain.ts) has no ENS deployment of
// its own - ENS names only resolve against Ethereum mainnet's registry, so
// this talks to Alchemy's separate eth-mainnet subdomain, not the
// robinhood-mainnet one lib/alchemy.ts uses. Same ALCHEMY_API_KEY works
// across both subdomains (normal for Alchemy, not project-scoped). Server
// only - must never be imported from a client component.
import { JsonRpcProvider } from "ethers";

const ETH_MAINNET_RPC_BASE = "https://eth-mainnet.g.alchemy.com/v2";

function apiKey(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY is not configured.");
  return key;
}

let cachedProvider: JsonRpcProvider | null = null;

// One provider instance reused across calls in the same server process,
// same reasoning as not re-opening a new DB connection per request.
function mainnetProvider(): JsonRpcProvider {
  if (!cachedProvider) {
    cachedProvider = new JsonRpcProvider(`${ETH_MAINNET_RPC_BASE}/${apiKey()}`);
  }
  return cachedProvider;
}

// Resolves an ENS name (e.g. "vitalik.eth") to a checksummed address via
// ethers' built-in resolveName - null if the name doesn't resolve to
// anything, never throws for a plain "not found" case.
export async function resolveEnsName(name: string): Promise<string | null> {
  return mainnetProvider().resolveName(name);
}

// Nice-to-have reverse lookup for the recipient preview - best-effort only,
// swallow failures since this is purely cosmetic.
export async function lookupEnsName(address: string): Promise<string | null> {
  try {
    return await mainnetProvider().lookupAddress(address);
  } catch {
    return null;
  }
}
