// Per-token OpenSea API v2 lookup, written fresh for this app - the parent
// h00dchan repo's lib/opensea.ts only ever calls the COLLECTION-level
// endpoint (GET /collections/{slug}, for the ad-rental feature's
// image/is_nsfw pre-filter). This module follows that file's same raw-fetch
// convention (x-api-key header, OPENSEA_API_KEY server-only env var, no SDK)
// but hits the per-NFT endpoint instead:
//   GET /api/v2/chain/{chain}/contract/{address}/nfts/{identifier}
//
// WHY THIS EXISTS, AND WHY IT'S SECONDARY NOW (read before wiring this into
// anything that costs money/rate-limit budget):
//
// script/Deploy.s.sol's own header comment (and the original design spec)
// asserted `STATUS: "Upgraded"` is OpenSea-only - "not in the IPFS tokenURI
// metadata" - and that this per-token OpenSea call would therefore be the
// ONLY way to detect it. That assertion was re-verified live on 2026-08-22
// against the three known-Upgraded anchor tokens the spec itself names, and
// it does NOT hold today:
//
//   curl https://hoodchan-metadata-service.vercel.app/metadata/531
//     -> {"attributes":[...,{"trait_type":"STATUS","value":"Upgraded"}]}
//   curl .../metadata/777  -> same, STATUS: "Upgraded" present
//   curl .../metadata/1067 -> same, STATUS: "Upgraded" present
//
// All three carry `STATUS: "Upgraded"` directly in their tokenURI JSON
// today - lib/chain.ts's fetchTokenMetadata (a single free IPFS/HTTP fetch
// already being made for gene mapping) is sufficient to detect Upgraded
// status with NO extra OpenSea call. scripts/sync-genes.ts therefore treats
// tokenURI's own STATUS field as the PRIMARY source and only calls this
// module as an optional cross-check (--check-opensea flag, off by default)
// against unpaginated 1200-token OpenSea rate limits.
//
// This module is still implemented and kept live per the task spec, for two
// real reasons: (1) metadata services for actively-developed collections do
// change - a future re-verification could find tokenURI stops carrying
// STATUS and this becomes load-bearing again; (2) it's a genuine second
// signal for catching any Upgraded token whose tokenURI is stale/uncached
// at sync time. Treat any disagreement between the two sources as a signal
// to investigate, not silently prefer one - see sync-genes.ts's
// reconcileUpgradedStatus.
const OPENSEA_API_BASE = "https://api.opensea.io/api/v2";
const FETCH_TIMEOUT_MS = 10_000;

// OpenSea's chain identifier for Robinhood Chain (id 4663) is NOT
// independently confirmed here - this repo has no evidence OpenSea indexes
// Robinhood Chain at all (it's small/new; HOODCHAN's own site links to
// Blockscout, not OpenSea, for the explorer). Overridable via env because
// of that uncertainty; a 404/"chain not found" response from this module
// should be read as "OpenSea doesn't cover this chain," not "this token
// isn't Upgraded" - sync-genes.ts treats a failed OpenSea lookup as
// "unknown," never as a negative signal, for exactly this reason.
export const OPENSEA_CHAIN_SLUG = process.env.OPENSEA_CHAIN_SLUG ?? "robinhood";

function apiKey(): string | null {
  return process.env.OPENSEA_API_KEY ?? null;
}

export interface OpenSeaTokenStatus {
  ok: boolean;
  isUpgraded: boolean | null; // null = couldn't determine (no key / lookup failed / trait absent)
  reason?: string;
  raw?: unknown;
}

// Reads STATUS off OpenSea's own per-NFT `traits` array (same schema shape
// as tokenURI's `attributes`: trait_type/value pairs) rather than any
// OpenSea-specific "Upgraded" concept - OpenSea doesn't have one; it's just
// mirroring whatever trait_type/value pairs the underlying metadata has.
export async function fetchOpenSeaTokenUpgradedStatus(
  contractAddress: string,
  tokenId: number | string,
): Promise<OpenSeaTokenStatus> {
  const key = apiKey();
  if (!key) {
    return {
      ok: false,
      isUpgraded: null,
      reason: "OPENSEA_API_KEY not configured",
    };
  }

  const url = `${OPENSEA_API_BASE}/chain/${OPENSEA_CHAIN_SLUG}/contract/${contractAddress}/nfts/${tokenId}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      isUpgraded: null,
      reason: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      isUpgraded: null,
      reason: "404 - chain slug or token not found on OpenSea",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      isUpgraded: null,
      reason: `OpenSea responded ${res.status}`,
    };
  }

  const data = await res.json();
  const traits: Array<{ trait_type?: string; value?: unknown }> = Array.isArray(
    data?.nft?.traits,
  )
    ? data.nft.traits
    : [];
  const statusTrait = traits.find(
    (t) => t.trait_type?.toLowerCase() === "status",
  );
  if (!statusTrait) {
    return { ok: true, isUpgraded: false, raw: data };
  }
  return {
    ok: true,
    isUpgraded: String(statusTrait.value).toLowerCase() === "upgraded",
    raw: data,
  };
}
