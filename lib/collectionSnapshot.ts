// One global, cached pass over HOODCHAN's full Transfer-event history that
// answers three different gamified-holding questions at once, all from the
// exact same data: who currently owns each token (avoids N individual
// ownerOf() calls), how many live HOODCHAN tokens each wallet currently
// holds (collector count / top holder), and how long the current owner has
// held each token (hodler streak - the most recent Transfer INTO that owner
// IS the acquisition time, no separate storage needed, matches this repo's
// "compute live from existing chain state" leveling philosophy - see
// lib/leveling.ts).
//
// Uses the paid Alchemy RPC, not lib/chain.ts's public rpcCall - this scan
// makes one eth_getLogs call plus potentially hundreds of
// eth_getBlockByNumber calls (one per unique block a Transfer landed in),
// and the public Robinhood RPC is documented elsewhere in this codebase
// (and reconfirmed live earlier today, batch-activating TBAs) as rate-
// limited under exactly this kind of burst. Cached for 5 minutes -
// acquisition timestamps are compared against week-wide boundaries, so
// second-level freshness is never needed, and this keeps the expensive
// scan off the hot path the same way lib/leaderboard.ts's own cache does
// for its lighter computation.
import { CONTRACT } from "@/lib/chain";

const ALCHEMY_RPC_BASE = "https://robinhood-mainnet.g.alchemy.com/v2";
const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS_TOPIC = `0x${"0".repeat(64)}`;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_MS = 5 * 60_000;
const BLOCK_TIMESTAMP_CONCURRENCY = 20;

function apiKey(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY is not configured.");
  return key;
}

async function alchemyRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`${ALCHEMY_RPC_BASE}/${apiKey()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

function decodeUint256(hex: string): string {
  return BigInt(hex).toString();
}
function decodeAddress(topic: string): string {
  return `0x${topic.replace(/^0x/, "").slice(-40)}`;
}

interface RpcLog {
  topics: string[];
  blockNumber: string;
  [key: string]: unknown;
}

export interface CollectionSnapshot {
  ownerOfToken: Map<string, string>; // tokenId -> current owner (lowercased)
  acquiredAtMs: Map<string, number>; // tokenId -> ms timestamp current owner received it
  tokensByOwner: Map<string, string[]>; // lowercased owner -> live tokenIds held
  topHolder: { address: string; count: number } | null;
}

interface SnapshotCacheGlobal {
  __h00dchanCollectionSnapshotCache?: {
    at: number;
    value: CollectionSnapshot;
  } | null;
  __h00dchanCollectionSnapshotPromise?: Promise<CollectionSnapshot> | null;
}
const cacheHolder = globalThis as SnapshotCacheGlobal;

async function computeSnapshot(): Promise<CollectionSnapshot> {
  const logs = await alchemyRpc<RpcLog[]>("eth_getLogs", [
    {
      address: CONTRACT,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [TRANSFER_EVENT_TOPIC],
    },
  ]);

  // Latest Transfer per tokenId (by block number) is the token's current
  // owner and the moment they acquired it - one full-history scan replaces
  // what would otherwise be a live ownerOf() call per token.
  const latestByToken = new Map<string, RpcLog>();
  for (const log of logs) {
    const tokenId = decodeUint256(log.topics[3]);
    const existing = latestByToken.get(tokenId);
    if (!existing || BigInt(log.blockNumber) >= BigInt(existing.blockNumber)) {
      latestByToken.set(tokenId, log);
    }
  }

  const ownerOfToken = new Map<string, string>();
  const tokensByOwner = new Map<string, string[]>();
  const uniqueBlocks = new Set<string>();

  for (const [tokenId, log] of latestByToken) {
    // Burned tokens' latest Transfer is to the zero address - not live-held
    // by anyone, excluded from every downstream metric.
    if (log.topics[2] === ZERO_ADDRESS_TOPIC) continue;
    const owner = decodeAddress(log.topics[2]).toLowerCase();
    ownerOfToken.set(tokenId, owner);
    const list = tokensByOwner.get(owner) ?? [];
    list.push(tokenId);
    tokensByOwner.set(owner, list);
    uniqueBlocks.add(log.blockNumber);
  }

  const blockTimestamps = new Map<string, number>();
  const blockList = [...uniqueBlocks];
  for (let i = 0; i < blockList.length; i += BLOCK_TIMESTAMP_CONCURRENCY) {
    const batch = blockList.slice(i, i + BLOCK_TIMESTAMP_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (blockNumber) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const block = await alchemyRpc<{ timestamp: string }>(
              "eth_getBlockByNumber",
              [blockNumber, false],
            );
            return {
              blockNumber,
              timestampMs: Number(BigInt(block.timestamp)) * 1000,
            };
          } catch {
            // one retry, then give up on this block - acquiredAtMs just
            // stays unset for tokens in it, and hodler XP degrades to 0
            // for them rather than crashing the whole snapshot.
          }
        }
        return null;
      }),
    );
    for (const r of results) {
      if (r) blockTimestamps.set(r.blockNumber, r.timestampMs);
    }
  }

  const acquiredAtMs = new Map<string, number>();
  for (const [tokenId, log] of latestByToken) {
    if (!ownerOfToken.has(tokenId)) continue; // burned, skipped above
    const ts = blockTimestamps.get(log.blockNumber);
    if (ts) acquiredAtMs.set(tokenId, ts);
  }

  let topHolder: { address: string; count: number } | null = null;
  for (const [address, tokens] of tokensByOwner) {
    if (!topHolder || tokens.length > topHolder.count) {
      topHolder = { address, count: tokens.length };
    }
  }

  return { ownerOfToken, acquiredAtMs, tokensByOwner, topHolder };
}

export async function getCollectionSnapshot(): Promise<CollectionSnapshot> {
  const cached = cacheHolder.__h00dchanCollectionSnapshotCache;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  // In-flight de-dup: a burst of concurrent requests during a cold cache
  // must not each trigger their own full log scan (same class of bug as
  // the original homepage TTFB spike this session already fixed once).
  if (cacheHolder.__h00dchanCollectionSnapshotPromise) {
    return cacheHolder.__h00dchanCollectionSnapshotPromise;
  }

  const promise = computeSnapshot()
    .then((value) => {
      cacheHolder.__h00dchanCollectionSnapshotCache = { at: Date.now(), value };
      cacheHolder.__h00dchanCollectionSnapshotPromise = null;
      return value;
    })
    .catch((err) => {
      cacheHolder.__h00dchanCollectionSnapshotPromise = null;
      throw err;
    });
  cacheHolder.__h00dchanCollectionSnapshotPromise = promise;
  return promise;
}

// Weeks the current owner has held a token, floored - used by
// lib/leveling.ts's hodler-streak XP. 0 for a token with no resolvable
// acquisition timestamp (e.g. a block whose timestamp lookup failed) or
// one that isn't in the snapshot (burned).
export function weeksHeld(
  snapshot: CollectionSnapshot,
  tokenId: string,
): number {
  const acquiredAtMs = snapshot.acquiredAtMs.get(tokenId);
  if (!acquiredAtMs) return 0;
  const msHeld = Date.now() - acquiredAtMs;
  return Math.max(0, Math.floor(msHeld / (7 * 24 * 60 * 60 * 1000)));
}

// Other live HOODCHAN tokens the same wallet holds, beyond this one -
// used by lib/leveling.ts's collector-bonus XP.
export function extraCollectionTokens(
  snapshot: CollectionSnapshot,
  tokenId: string,
): number {
  const owner = snapshot.ownerOfToken.get(tokenId);
  if (!owner) return 0;
  const held = snapshot.tokensByOwner.get(owner) ?? [];
  return Math.max(0, held.length - 1);
}

export function isTopHolder(
  snapshot: CollectionSnapshot,
  tokenId: string,
): boolean {
  const owner = snapshot.ownerOfToken.get(tokenId);
  if (!owner || !snapshot.topHolder) return false;
  return owner === snapshot.topHolder.address;
}

// Other live HOODCHAN tokens sitting inside THIS token's own token-bound
// wallet - the token-bound-account address is just another address as far
// as this snapshot's tokensByOwner map is concerned, so no separate scan
// is needed to answer "is anon #12 holding other anons inside itself".
export function nestedHoldingCount(
  snapshot: CollectionSnapshot,
  tbaAddress: string,
): number {
  const held = snapshot.tokensByOwner.get(tbaAddress.toLowerCase()) ?? [];
  return held.length;
}
