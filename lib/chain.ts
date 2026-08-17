// Direct on-chain reads for the HOODCHAN collection on Robinhood Chain.
// Raw JSON-RPC eth_call - no viem/ethers dependency, same zero-dependency
// philosophy as hoodies-fight/src/chain.js, which this is ported from.
//
// Contract address, chain ID, RPC, and ABI selectors independently verified
// via eth_call against Robinhood Chain mainnet (name="HOODCHAN", symbol="HC",
// totalSupply=1200), not guessed. tokenOfOwnerByIndex was also live-tested
// (selector 0x2f745c59) against a real token holder (owner of token #1) and
// it reverts - this contract does NOT implement ERC721Enumerable, so wallet
// ownership has to be derived from Transfer event logs instead, same as the
// source file's fallback approach.
//
// Unlike the source project (OnChainHoodies, fully on-chain: tokenURI
// returns a data:application/json URI with inline SVG), HOODCHAN's
// tokenURI resolves to an ipfs:// URI pointing at standard OpenSea-schema
// JSON (name/image/attributes) - so metadata resolution here needs an
// actual IPFS gateway fetch, not just base64/data-URI decoding.

export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const CONTRACT = "0x774Db2207D26570F5638028839c816702A40aBC2";
export const CHAIN_ID_HEX = "0x1237"; // 4663
// Plain string, deliberately not re-exported from lib/appkit.ts's
// robinhoodChain object - that module is "use client" (Reown/AppKit touches
// window), so importing it into a Server Component doesn't carry the real
// value across the boundary and silently resolves to undefined instead of
// throwing. Server-rendered pages that link out to the explorer (e.g.
// app/wallet/[tokenId]/page.tsx) must use this constant instead.
export const BLOCK_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

const SELECTOR_OWNER_OF = "6352211e"; // ownerOf(uint256)
const SELECTOR_TOKEN_URI = "c87b56dd"; // tokenURI(uint256)

function encodeUint256(tokenId: number | string | bigint): string {
  return BigInt(tokenId).toString(16).padStart(64, "0");
}

// Applied to every fetch in this file: a hung RPC or IPFS gateway should
// fail fast rather than hold a request slot open indefinitely, which
// matters more than usual here since these calls sit on the hot path of
// every board write's live ownership check (see lib/auth-server.ts) - a
// slow-loris-style hang against one of these upstreams would compound into
// the rate-limited write path timing out for everyone, not just failing
// for the one slow request.
const FETCH_TIMEOUT_MS = 8_000;

async function ethCall(
  selector: string,
  tokenId: number | string | bigint,
): Promise<string> {
  const data = `0x${selector}${encodeUint256(tokenId)}`;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: CONTRACT, data }, "latest"],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "eth_call failed");
  return body.result as string; // 0x-prefixed hex
}

// ABI-decodes a single `address` return value - right-aligned in the last
// 20 bytes of one 32-byte word.
function decodeAddress(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  return `0x${clean.slice(-40)}`;
}

// ABI-decodes a single dynamic `string` return value: 32-byte offset
// (ignored, always 0x20 for a lone return value), 32-byte length, then the
// UTF-8 bytes themselves padded to a 32-byte boundary.
function decodeString(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  const lengthHex = clean.slice(64, 128);
  const length = parseInt(lengthHex, 16);
  const dataHex = clean.slice(128, 128 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export async function readOwnerOf(
  tokenId: number | string | bigint,
): Promise<string> {
  const result = await ethCall(SELECTOR_OWNER_OF, tokenId);
  return decodeAddress(result);
}

export async function readTokenURI(
  tokenId: number | string | bigint,
): Promise<string> {
  const result = await ethCall(SELECTOR_TOKEN_URI, tokenId);
  return decodeString(result);
}

const SELECTOR_TOTAL_SUPPLY = "18160ddd"; // totalSupply()

// Live circulating supply - decrements on burn (verified live: this
// contract minted 1200 but totalSupply() currently reads 1198 after two
// confirmed burns, tokens #5 and #6, found via Transfer-to-zero-address
// logs below). This is the correct denominator for "how many anons exist
// right now", not the static mint count of 1200.
export async function readTotalSupply(): Promise<number> {
  const data = `0x${SELECTOR_TOTAL_SUPPLY}`;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: CONTRACT, data }, "latest"],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "eth_call failed");
  return Number(BigInt(body.result as string));
}

const ZERO_ADDRESS_TOPIC = `0x${"0".repeat(64)}`;

// Every token ID this contract has ever burned (Transfer(from, to=0x0,
// tokenId)) - a single eth_getLogs call covering the whole contract
// history, not a per-token probe. `ownerOf`/`tokenURI` revert identically
// for a burned token and a never-minted one, so this log-based approach is
// the only way to tell "this specific ID was minted then burned" apart
// from "this ID was never minted" - not that the distinction matters much
// here (every ID 1-1200 was minted, confirmed via the original totalSupply
// read of exactly 1200), but the log lookup is also just the cheapest way
// to get the full burned-ID list in one call instead of probing all 1200.
export async function fetchBurnedTokenIds(): Promise<string[]> {
  const logs = await rpcCall<RpcLog[]>("eth_getLogs", [
    {
      address: CONTRACT,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [TRANSFER_EVENT_TOPIC, null, ZERO_ADDRESS_TOPIC],
    },
  ]);
  return [...new Set(logs.map((log) => decodeUint256(log.topics[3])))];
}

// --- Transfer-log wallet ownership scan ---------------------------------
//
// No ERC721Enumerable (confirmed live: tokenOfOwnerByIndex reverts) - so
// there's no direct "list token IDs owned by X" call. Transfer event logs
// stand in for that instead: every token this address ever received shows
// up as a Transfer with `to` = address, which gives a candidate list even
// though some of those may have since been transferred away again.
const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function addressToTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.replace(/^0x/, "").toLowerCase()}`;
}

function decodeUint256(hex: string): string {
  return BigInt(hex).toString();
}

interface RpcLog {
  topics: string[];
  [key: string]: unknown;
}

export async function rpcCall<T>(
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

// Candidates from Transfer logs aren't necessarily still owned - someone
// could have received a token and later sold it - so each one gets a live
// ownerOf() check before being trusted. Capped and chunked rather than
// firing them all at once: a high-churn wallet (many past transfers, most
// no longer held) could otherwise mean hundreds of concurrent RPC calls for
// one wallet connect.
// Exported - lib/auth-server.ts's verifyBatchPersonaClaim reuses this exact
// concurrency budget for its own per-token ownerOf checks against the same
// RPC, rather than duplicating a second magic number.
export const OWNERSHIP_CHECK_CONCURRENCY = 15;
const MAX_CANDIDATES = 300;

// Current chain head, in hex - used by callers doing incremental log scans
// (see fetchWalletTokensOnChain's fromBlock option below) to record "scanned
// up to here" after a scan completes.
export async function readBlockNumber(): Promise<string> {
  return rpcCall<string>("eth_blockNumber", []);
}

export async function fetchWalletTokensOnChain(
  address: string,
  options?: { fromBlock?: string; knownTokenIds?: string[] },
): Promise<string[]> {
  // fromBlock lets a caller that already scanned this address before only
  // ask for Transfers since that point, instead of re-walking the whole
  // contract history on every single page load - the actual bottleneck
  // this exists to avoid. knownTokenIds carries forward whatever that prior
  // scan found; every ID (old and newly-discovered) still gets a fresh
  // ownerOf() check below, so a token sold away since the last scan is
  // correctly dropped, not just accumulated forever.
  const logs = await rpcCall<RpcLog[]>("eth_getLogs", [
    {
      address: CONTRACT,
      fromBlock: options?.fromBlock ?? "0x0",
      toBlock: "latest",
      topics: [TRANSFER_EVENT_TOPIC, null, addressToTopic(address)],
    },
  ]);

  const candidateIds = [
    ...new Set([
      ...(options?.knownTokenIds ?? []),
      ...logs.map((log) => decodeUint256(log.topics[3])),
    ]),
  ].slice(0, MAX_CANDIDATES);

  // One retry per candidate before giving up on it - same reasoning as
  // app/api/wallet-tokens/route.ts's TBA lookups (which already do this):
  // readOwnerOf has no retry of its own, and a bare .catch(() => null) on
  // a single transient RPC blip silently drops a token the address
  // genuinely owns, with nothing to signal it happened. Caught live: a
  // real 9-token wallet intermittently showed as few as 3 on a plain
  // reload - not a chunking-scale problem (9 fits in one
  // OWNERSHIP_CHECK_CONCURRENCY batch already), just occasional
  // single-request flakiness with no retry to absorb it.
  const owned: string[] = [];
  for (let i = 0; i < candidateIds.length; i += OWNERSHIP_CHECK_CONCURRENCY) {
    const batch = candidateIds.slice(i, i + OWNERSHIP_CHECK_CONCURRENCY);
    const owners = await Promise.all(
      batch.map(async (id) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await readOwnerOf(id);
          } catch {
            // one retry, then give up on this candidate
          }
        }
        return null;
      }),
    );
    batch.forEach((id, j) => {
      const owner = owners[j];
      if (owner && owner.toLowerCase() === address.toLowerCase()) {
        owned.push(id);
      }
    });
  }
  return owned;
}

// --- IPFS metadata resolution --------------------------------------------
//
// HOODCHAN's tokenURI returns an ipfs:// URI (e.g.
// ipfs://QmYWhTLQxif6duTiENGJQA9Avejwob1iZyqrHZXRMmKbHj/1) pointing at
// standard OpenSea-schema JSON, whose own `image` field is a second,
// separate ipfs:// URI/CID for the actual artwork.
//
// Gateway order matters and was verified live with curl, not guessed:
// ipfs.io and gateway.pinata.cloud both timed out entirely (>12s, no
// response) against this collection's CIDs, while nftstorage.link,
// dweb.link, and w3s.link all returned the real content in under 2s.
// ipfs.io in particular is a known-congested public gateway - don't lead
// with it. Ordered fastest-and-most-reliable first based on that test.
// gateway.pinata.cloud appended as a last-resort fallback: historically slow
// against this collection's CIDs (hence not leading with it), but kept in
// the rotation since it was observed live to succeed - including from
// network conditions where the subdomain-per-CID redirect the other three
// gateways issue (nftstorage.link/dweb.link/w3s.link all 301/302 to a
// `<cid>.ipfs.<gateway>` host) gets blocked by TLS-layer filtering before it
// ever reaches the gateway - pinata.cloud serves path-style
// (`/ipfs/<cid>/...`) without that subdomain hop.
// alchemy.mypinata.cloud added after all 5 gateways above showed a spike in
// failures under real production load (verified live: a full-collection
// backfill run saw roughly 60-70% failure rate across the original five,
// almost certainly rate-limiting from this app's own burst traffic hitting
// them repeatedly). It's Pinata's own shared gateway (referenced in
// Alchemy's docs, not something gated by an Alchemy API key specifically -
// no auth was needed to use it) - tested live and fast (~1s, 200) at the
// exact moment several of the others were failing. A genuinely different
// operator from the rest of this list, which is the point: gateways going
// down together correlates by provider, not randomly.
// Paid dedicated gateway (Pinata account already owned, not a new signup) -
// leads the list now that it's wired up. A dedicated gateway is restricted
// to self-pinned content by default; HOODCHAN's art was never pinned to
// this account, so a Gateway Access Token was created (POST
// /v3/ipfs/gateways/{id}/access_tokens) to open it to the whole public IPFS
// network instead - verified live against CIDs that were failing across
// every other gateway during a full-collection backfill. The token is
// NEXT_PUBLIC_ deliberately: Pinata's own docs describe attaching this
// exact kind of token to public gateway URLs as the intended pattern (it's
// a low-privilege gateway-read token, unlike the account JWT/API keys - a
// leak risks quota abuse, not account compromise), and it needs to reach
// client-rendered <img src> URLs, not just server-side fetches.
function dedicatedGatewayUrl(cidPath: string): string | null {
  const domain = process.env.NEXT_PUBLIC_PINATA_GATEWAY_DOMAIN;
  const token = process.env.NEXT_PUBLIC_PINATA_GATEWAY_TOKEN;
  if (!domain || !token) return null;
  return `https://${domain}/ipfs/${cidPath}?pinataGatewayToken=${token}`;
}

const PUBLIC_IPFS_GATEWAYS: Array<(cidPath: string) => string> = [
  (cidPath) => `https://alchemy.mypinata.cloud/ipfs/${cidPath}`,
  (cidPath) => `https://nftstorage.link/ipfs/${cidPath}`,
  (cidPath) => `https://dweb.link/ipfs/${cidPath}`,
  (cidPath) => `https://w3s.link/ipfs/${cidPath}`,
  (cidPath) => `https://ipfs.io/ipfs/${cidPath}`,
  (cidPath) => `https://gateway.pinata.cloud/ipfs/${cidPath}`,
];

function allGatewayUrls(cidPath: string): string[] {
  const dedicated = dedicatedGatewayUrl(cidPath);
  const publicUrls = PUBLIC_IPFS_GATEWAYS.map((gateway) => gateway(cidPath));
  return dedicated ? [dedicated, ...publicUrls] : publicUrls;
}

function ipfsUriToPath(uri: string): string {
  return uri.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
}

// Resolves an ipfs:// URI to an https gateway URL suitable for an <img src>
// or a fetch() call. Non-ipfs URIs pass through unchanged. Leads with the
// dedicated gateway when configured (see dedicatedGatewayUrl above).
export function resolveIpfsUri(uri: string): string {
  if (!uri.startsWith("ipfs://")) return uri;
  return allGatewayUrls(ipfsUriToPath(uri))[0];
}

// Full ordered list of gateway URLs for one ipfs:// URI - lets callers (e.g.
// an <img onError>) retry the next gateway instead of giving up on the
// first one, since individual gateways are observably flaky even when the
// underlying content is available (verified live: ipfs.io and Pinata's
// public gateway both timed out on this collection's CIDs while others
// served the same content in under 2s).
export function ipfsGatewayUrls(uri: string): string[] {
  if (!uri.startsWith("ipfs://")) return [uri];
  return allGatewayUrls(ipfsUriToPath(uri));
}

// Races all gateways concurrently (Promise.any) rather than trying them
// one at a time. Sequential fallback across several gateways at an 8s
// timeout each meant a single genuinely-slow CID could take up to 40s to
// fail - verified live: this exact path caused production requests to hang
// for 20s+ before this change, well past what any user will wait for a
// page to load. Racing bounds worst case to ~8s (all gateways timing out
// together) and improves the common case too, since whichever gateway
// happens to be fastest right now wins instead of always paying for the
// same one first even on days it's the slow one.
async function fetchIpfsJson(uri: string): Promise<unknown> {
  const cidPath = ipfsUriToPath(uri);
  const attempts = allGatewayUrls(cidPath).map(async (url) => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`IPFS gateway responded ${res.status}`);
    return res.json();
  });

  try {
    return await Promise.any(attempts);
  } catch (err) {
    // AggregateError when every gateway rejected - surface something
    // readable instead of the raw multi-error blob.
    throw new Error(
      `All IPFS gateways failed: ${err instanceof AggregateError ? err.errors.map((e) => e?.message ?? String(e)).join("; ") : String(err)}`,
    );
  }
}

export interface TokenAttribute {
  trait_type?: string;
  value?: string | number;
}

export interface TokenMetadata {
  tokenId: string;
  name: string;
  image: string; // resolved to an https gateway URL, ready for <img src>
  attributes: TokenAttribute[];
  raw: Record<string, unknown>;
}

function parseTokenURI(uri: string): Promise<Record<string, unknown>> {
  if (uri.startsWith("data:application/json;base64,")) {
    const json = atob(uri.slice("data:application/json;base64,".length));
    return Promise.resolve(JSON.parse(json));
  }
  if (uri.startsWith("data:application/json,")) {
    return Promise.resolve(
      JSON.parse(
        decodeURIComponent(uri.slice("data:application/json,".length)),
      ),
    );
  }
  if (uri.startsWith("ipfs://") || uri.startsWith("ipfs/")) {
    return fetchIpfsJson(uri) as Promise<Record<string, unknown>>;
  }
  // Plain HTTP(S) fallback, in case tokenURI is ever repointed off IPFS.
  return fetch(uri).then((r) => r.json());
}

export async function fetchTokenMetadata(
  tokenId: number | string | bigint,
): Promise<TokenMetadata> {
  const uri = await readTokenURI(tokenId);
  const metadata = await parseTokenURI(uri);
  const image =
    typeof metadata.image === "string" ? resolveIpfsUri(metadata.image) : "";
  return {
    tokenId: String(tokenId),
    name:
      typeof metadata.name === "string" ? metadata.name : `Anon #${tokenId}`,
    image,
    attributes: Array.isArray(metadata.attributes)
      ? (metadata.attributes as TokenAttribute[])
      : [],
    raw: metadata,
  };
}
