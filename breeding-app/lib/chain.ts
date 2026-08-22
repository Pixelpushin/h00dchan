// Raw JSON-RPC reads against Robinhood Chain - no viem/ethers provider, same
// zero-dependency-for-reads convention as the parent h00dchan app's
// lib/chain.ts (this file is a self-contained fork of it, generalized to
// take a contract address per call instead of one hardcoded HOODCHAN
// address, since this app reads from four different contracts: HOODCHAN,
// Girlfriends, Babies, and BreedingController). Not imported from the
// parent app on purpose - this ships as its own separate Vercel project.
import { DEFAULT_RPC_URL } from "@/lib/config";

const FETCH_TIMEOUT_MS = 8_000;

export async function rpcCall<T>(
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(DEFAULT_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

export async function ethCall(to: string, data: string): Promise<string> {
  return rpcCall<string>("eth_call", [{ to, data }, "latest"]);
}

export function encodeUint256(value: number | string | bigint): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

export function selector(signature: string): string {
  // Tiny, dependency-free 4-byte selector helper is NOT used here - real
  // keccak256 of a function signature can't be computed without a hashing
  // library, so every selector in this file is a literal, independently
  // verifiable constant (same convention as the parent app's lib/chain.ts,
  // which hardcodes SELECTOR_OWNER_OF / SELECTOR_TOKEN_URI the same way)
  // rather than computed at runtime. This helper exists only as
  // documentation of which signature a literal below corresponds to.
  return signature;
}

// --- Standard ERC-721/ERC-20 selectors (identical across all four
// contracts this app talks to - HOODCHAN, Girlfriends, Babies all share
// the plain ERC-721 surface; CHAN is a plain ERC-20). ---
export const SEL_OWNER_OF = "6352211e"; // ownerOf(uint256)
export const SEL_TOKEN_URI = "c87b56dd"; // tokenURI(uint256)
export const SEL_BALANCE_OF = "70a08231"; // balanceOf(address)
export const SEL_TOTAL_SUPPLY = "18160ddd"; // totalSupply()
export const SEL_APPROVE = "095ea7b3"; // approve(address,uint256) - ERC-20

export function decodeAddress(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  return `0x${clean.slice(-40)}`;
}

export function decodeUint256(hex: string): bigint {
  return BigInt(hex);
}

// ABI-decodes a single dynamic `string` return value.
export function decodeString(hex: string): string {
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

// ABI-decodes a single dynamic `uint256[]` return value: 32-byte offset
// (ignored), 32-byte length, then that many 32-byte words.
export function decodeUint256Array(hex: string): bigint[] {
  const clean = hex.replace(/^0x/, "");
  if (clean.length < 128) return [];
  const length = parseInt(clean.slice(64, 128), 16);
  const out: bigint[] = [];
  for (let i = 0; i < length; i++) {
    const start = 128 + i * 64;
    out.push(BigInt(`0x${clean.slice(start, start + 64)}`));
  }
  return out;
}

export async function readOwnerOf(
  contract: string,
  tokenId: number | string | bigint,
): Promise<string> {
  const data = `0x${SEL_OWNER_OF}${encodeUint256(tokenId)}`;
  return decodeAddress(await ethCall(contract, data));
}

export async function readTokenURI(
  contract: string,
  tokenId: number | string | bigint,
): Promise<string> {
  const data = `0x${SEL_TOKEN_URI}${encodeUint256(tokenId)}`;
  return decodeString(await ethCall(contract, data));
}

export async function readBalanceOf(
  contract: string,
  owner: string,
): Promise<bigint> {
  const data = `0x${SEL_BALANCE_OF}${"0".repeat(24)}${owner.replace(/^0x/, "").toLowerCase()}`;
  return decodeUint256(await ethCall(contract, data));
}

export async function readTotalSupply(contract: string): Promise<bigint> {
  const data = `0x${SEL_TOTAL_SUPPLY}`;
  return decodeUint256(await ethCall(contract, data));
}

// --- Transfer-log wallet enumeration (no ERC721Enumerable on any of these
// contracts is assumed) - same fallback approach as the parent app's
// fetchWalletTokensOnChain: candidate IDs from Transfer logs, each
// confirmed live via ownerOf before being trusted. ---
const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function addressToTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.replace(/^0x/, "").toLowerCase()}`;
}

interface RpcLog {
  topics: string[];
  [key: string]: unknown;
}

export const OWNERSHIP_CHECK_CONCURRENCY = 15;
const MAX_CANDIDATES = 300;

export async function fetchWalletTokensOnChain(
  contract: string,
  address: string,
): Promise<string[]> {
  const logs = await rpcCall<RpcLog[]>("eth_getLogs", [
    {
      address: contract,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [TRANSFER_EVENT_TOPIC, null, addressToTopic(address)],
    },
  ]);

  const candidateIds = [
    ...new Set(logs.map((log) => decodeUint256(log.topics[3]).toString())),
  ].slice(0, MAX_CANDIDATES);

  const owned: string[] = [];
  for (let i = 0; i < candidateIds.length; i += OWNERSHIP_CHECK_CONCURRENCY) {
    const batch = candidateIds.slice(i, i + OWNERSHIP_CHECK_CONCURRENCY);
    const owners = await Promise.all(
      batch.map(async (id) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await readOwnerOf(contract, id);
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

// --- IPFS / metadata resolution - trimmed down copy of the parent app's
// gateway rotation (dedicated Pinata gateway first when configured, then
// the same fastest-first public gateway order verified live there). ---
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
];

function ipfsUriToPath(uri: string): string {
  return uri.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
}

export function resolveIpfsUri(uri: string): string {
  if (!uri.startsWith("ipfs://") && !uri.startsWith("ipfs/")) return uri;
  const cidPath = ipfsUriToPath(uri);
  const dedicated = dedicatedGatewayUrl(cidPath);
  return dedicated ?? PUBLIC_IPFS_GATEWAYS[0](cidPath);
}

async function fetchIpfsJson(uri: string): Promise<unknown> {
  const cidPath = ipfsUriToPath(uri);
  const dedicated = dedicatedGatewayUrl(cidPath);
  const urls = dedicated
    ? [dedicated, ...PUBLIC_IPFS_GATEWAYS.map((g) => g(cidPath))]
    : PUBLIC_IPFS_GATEWAYS.map((g) => g(cidPath));

  const attempts = urls.map(async (url) => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`IPFS gateway responded ${res.status}`);
    return res.json();
  });

  try {
    return await Promise.any(attempts);
  } catch (err) {
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
  image: string;
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
  return fetch(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(
    (r) => r.json(),
  );
}

export async function fetchTokenMetadata(
  contract: string,
  tokenId: number | string | bigint,
  fallbackName = "Token",
): Promise<TokenMetadata> {
  const uri = await readTokenURI(contract, tokenId);
  const metadata = await parseTokenURI(uri);
  const image =
    typeof metadata.image === "string" ? resolveIpfsUri(metadata.image) : "";
  return {
    tokenId: String(tokenId),
    name:
      typeof metadata.name === "string"
        ? metadata.name
        : `${fallbackName} #${tokenId}`,
    image,
    attributes: Array.isArray(metadata.attributes)
      ? (metadata.attributes as TokenAttribute[])
      : [],
    raw: metadata,
  };
}

export function findAttribute(
  attributes: TokenAttribute[],
  traitType: string,
): string | undefined {
  const found = attributes.find(
    (a) => a.trait_type?.toLowerCase() === traitType.toLowerCase(),
  );
  return found?.value !== undefined ? String(found.value) : undefined;
}
