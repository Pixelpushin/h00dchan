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

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
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
const OWNERSHIP_CHECK_CONCURRENCY = 15;
const MAX_CANDIDATES = 300;

export async function fetchWalletTokensOnChain(
  address: string,
): Promise<string[]> {
  const logs = await rpcCall<RpcLog[]>("eth_getLogs", [
    {
      address: CONTRACT,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [TRANSFER_EVENT_TOPIC, null, addressToTopic(address)],
    },
  ]);

  const candidateIds = [
    ...new Set(logs.map((log) => decodeUint256(log.topics[3]))),
  ].slice(0, MAX_CANDIDATES);

  const owned: string[] = [];
  for (let i = 0; i < candidateIds.length; i += OWNERSHIP_CHECK_CONCURRENCY) {
    const batch = candidateIds.slice(i, i + OWNERSHIP_CHECK_CONCURRENCY);
    const owners = await Promise.all(
      batch.map((id) => readOwnerOf(id).catch(() => null)),
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
const IPFS_GATEWAYS: Array<(cidPath: string) => string> = [
  (cidPath) => `https://alchemy.mypinata.cloud/ipfs/${cidPath}`,
  (cidPath) => `https://nftstorage.link/ipfs/${cidPath}`,
  (cidPath) => `https://dweb.link/ipfs/${cidPath}`,
  (cidPath) => `https://w3s.link/ipfs/${cidPath}`,
  (cidPath) => `https://ipfs.io/ipfs/${cidPath}`,
  (cidPath) => `https://gateway.pinata.cloud/ipfs/${cidPath}`,
];

function ipfsUriToPath(uri: string): string {
  return uri.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
}

// Resolves an ipfs:// URI to an https gateway URL suitable for an <img src>
// or a fetch() call. Non-ipfs URIs pass through unchanged.
export function resolveIpfsUri(uri: string): string {
  if (!uri.startsWith("ipfs://")) return uri;
  return IPFS_GATEWAYS[0](ipfsUriToPath(uri));
}

// Full ordered list of gateway URLs for one ipfs:// URI - lets callers (e.g.
// an <img onError>) retry the next gateway instead of giving up on the
// first one, since individual gateways are observably flaky even when the
// underlying content is available (verified live: ipfs.io and Pinata's
// gateway both timed out on this collection's CIDs while three other
// gateways served the same content in under 2s).
export function ipfsGatewayUrls(uri: string): string[] {
  if (!uri.startsWith("ipfs://")) return [uri];
  const cidPath = ipfsUriToPath(uri);
  return IPFS_GATEWAYS.map((gateway) => gateway(cidPath));
}

// Races all gateways concurrently (Promise.any) rather than trying them
// one at a time. Sequential fallback across 5 gateways at an 8s timeout
// each meant a single genuinely-slow CID could take up to 40s to fail -
// verified live: this exact path caused production requests to hang for
// 20s+ before this change, well past what any user will wait for a page
// to load. Racing bounds worst case to ~8s (all gateways timing out
// together) and improves the common case too, since whichever gateway
// happens to be fastest right now wins instead of always paying for
// nftstorage.link first even on days it's the slow one.
async function fetchIpfsJson(uri: string): Promise<unknown> {
  const cidPath = ipfsUriToPath(uri);
  const attempts = IPFS_GATEWAYS.map(async (gateway) => {
    const res = await fetch(gateway(cidPath), {
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
