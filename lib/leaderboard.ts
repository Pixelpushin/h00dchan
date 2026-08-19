// Leaderboard of anons by level - deliberately NOT a scan of all ~1198
// tokens. Checking wallet-activation status is a real on-chain RPC call
// per token (lib/tba.ts's isTbaActivated), and this session already hit
// (and fixed) exactly the class of bug that comes from firing that many
// requests at once. Instead, the candidate set is the union of two cheap,
// already-indexed signals: tokens ever claimed (a Redis SET, one SMEMBERS
// call) and tokens that have started a thread (from the already-cached
// listThreads()). A token that ONLY activated its wallet and never
// claimed or posted won't appear here - a real, disclosed limitation
// (surfaced in the leaderboard page's own copy), not a silent gap.
import {
  listEverClaimedTokenIds,
  listThreads,
  isTokenClaimed,
  countHumanPostsByToken,
  countHumanThreadsByToken,
  redisCommand,
} from "@/lib/store";
import * as tbaKit from "@pixelpushin/tba-kit";
import { CONTRACT, CHAIN_ID_HEX } from "@/lib/chain";
import { computeLevelProgress, type LevelProgress } from "@/lib/leveling";
import {
  getCollectionSnapshot,
  weeksHeld,
  extraCollectionTokens,
  isTopHolder,
  nestedHoldingCount,
} from "@/lib/collectionSnapshot";
import { getBioVerification } from "@/lib/bioVerifyStore";

// This file is server-only (never imported by a "use client" component,
// unlike lib/tba.ts which is), so it's safe to talk to Alchemy directly
// with the server-only ALCHEMY_API_KEY instead of going through
// lib/tba.ts's computeTbaAddress/isTbaActivated - those default to
// Robinhood Chain's public RPC (tba-kit's own ROBINHOOD_RPC_URL), which is
// documented elsewhere in this codebase as flaky under load and confirmed
// live here too: the leaderboard's total candidate count varied run to
// run (77, then 66) and one specific real claimed token (#165) dropped
// out of the results entirely on every single run - each candidate's
// computeTbaAddress/isTbaActivated call had no retry and no fallback off
// the public RPC, unlike every other per-token RPC path in this codebase
// that already got this fix today.
const ALCHEMY_RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : undefined;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

async function computeTbaAddress(tokenId: string): Promise<string> {
  return withRetry(() =>
    tbaKit.computeTbaAddress({
      tokenContract: CONTRACT,
      tokenId,
      chainIdHex: CHAIN_ID_HEX,
      rpcUrl: ALCHEMY_RPC_URL,
    }),
  );
}

async function isTbaActivated(tbaAddress: string): Promise<boolean> {
  return withRetry(() => tbaKit.isTbaActivated(tbaAddress, ALCHEMY_RPC_URL));
}

async function getTransactionCount(address: string): Promise<string> {
  if (!ALCHEMY_RPC_URL) return "0x0";
  return withRetry(() =>
    tbaKit.rpcCall<string>(ALCHEMY_RPC_URL, "eth_getTransactionCount", [
      address,
      "latest",
    ]),
  );
}

export interface LeaderboardEntry {
  tokenId: string;
  level: number;
  totalXp: number;
  claimed: boolean;
  walletActivated: boolean;
  breakdown: LevelProgress["breakdown"];
  hodlerWeeks: number;
  isTopHolder: boolean;
  nestedHoldingCount: number;
}

const CANDIDATE_CONCURRENCY = 10;
const CACHE_MS = 60_000;
// Confirmed live: a cold real-user request measured 10s+ end to end
// (~560 candidates, 3 RPC calls each, batched 10 at a time). The
// in-memory globalThis cache below never helped most visitors, because
// Vercel serverless instances don't stay warm reliably - each cold
// invocation started from zero regardless of how recently someone else
// had just paid the same 10s cost. This Redis-backed cache is the actual
// fix: durable across invocations, so only the first visitor after a
// 5-minute window pays the real computation cost, everyone else gets an
// instant cached read.
const REDIS_CACHE_KEY = "leaderboard:cache";
const REDIS_CACHE_TTL_MS = 5 * 60 * 1000;

interface LeaderboardCacheGlobal {
  __h00dchanLeaderboardCache?: { at: number; value: LeaderboardEntry[] } | null;
}
const cacheHolder = globalThis as LeaderboardCacheGlobal;

async function readRedisCache(): Promise<{
  at: number;
  value: LeaderboardEntry[];
} | null> {
  try {
    const raw = await redisCommand("GET", REDIS_CACHE_KEY);
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw) as { at: number; value: LeaderboardEntry[] };
    if (Date.now() - parsed.at > REDIS_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function computeLeaderboard(): Promise<LeaderboardEntry[]> {
  const cached = cacheHolder.__h00dchanLeaderboardCache;
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }

  const redisCached = await readRedisCache();
  if (redisCached) {
    cacheHolder.__h00dchanLeaderboardCache = redisCached;
    return redisCached.value;
  }

  const [everClaimed, threads, snapshot] = await Promise.all([
    listEverClaimedTokenIds(),
    listThreads(),
    getCollectionSnapshot().catch(() => null),
  ]);

  // Only used to widen the candidate set (any token that has EVER started
  // a thread, human or AI, is worth a real level check) - NOT used for
  // the actual XP calculation below anymore, which needs human-only
  // counts (countHumanThreadsByToken/countHumanPostsByToken) so an
  // unclaimed anon's AI-authored thread doesn't itself earn XP once
  // someone claims it.
  const threadStarterIds = new Set(threads.map((t) => t.tokenId));

  const candidateIds = new Set<string>(everClaimed);
  for (const tokenId of threadStarterIds) candidateIds.add(tokenId);
  const candidates = [...candidateIds];

  const entries: LeaderboardEntry[] = [];
  for (let i = 0; i < candidates.length; i += CANDIDATE_CONCURRENCY) {
    const batch = candidates.slice(i, i + CANDIDATE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (tokenId): Promise<LeaderboardEntry | null> => {
        try {
          const tbaAddress = await computeTbaAddress(tokenId);
          const [
            claimed,
            walletActivated,
            humanTotalPosts,
            humanThreadsStarted,
            txCountHex,
            bioVerification,
          ] = await Promise.all([
            isTokenClaimed(tokenId).catch(() => false),
            isTbaActivated(tbaAddress).catch(() => false),
            countHumanPostsByToken(tokenId).catch(() => 0),
            countHumanThreadsByToken(tokenId).catch(() => 0),
            getTransactionCount(tbaAddress).catch(() => "0x0"),
            getBioVerification(tokenId).catch(() => null),
          ]);
          // Everything below comes free from the one shared, cached
          // collection scan above - no per-candidate RPC calls needed for
          // hodler/collector/top-holder/nested, unlike the isTbaActivated
          // and tx-count calls above which genuinely need a live check.
          const progress: LevelProgress = computeLevelProgress({
            claimed,
            threadsStarted: humanThreadsStarted,
            totalPosts: humanTotalPosts,
            hasSentTransaction: BigInt(txCountHex) > BigInt(0),
            hodlerWeeks: snapshot ? weeksHeld(snapshot, tokenId) : 0,
            extraCollectionTokens: snapshot
              ? extraCollectionTokens(snapshot, tokenId)
              : 0,
            isTopHolder: snapshot ? isTopHolder(snapshot, tokenId) : false,
            nestedHoldingCount: snapshot
              ? nestedHoldingCount(snapshot, tbaAddress)
              : 0,
            bioVerified: bioVerification?.status === "verified",
          });
          return {
            tokenId,
            level: progress.level,
            totalXp: progress.totalXp,
            claimed,
            walletActivated,
            breakdown: progress.breakdown,
            hodlerWeeks: snapshot ? weeksHeld(snapshot, tokenId) : 0,
            isTopHolder: snapshot ? isTopHolder(snapshot, tokenId) : false,
            nestedHoldingCount: snapshot
              ? nestedHoldingCount(snapshot, tbaAddress)
              : 0,
          };
        } catch {
          return null;
        }
      }),
    );
    for (const entry of results) if (entry) entries.push(entry);
  }

  entries.sort(
    (a, b) => b.totalXp - a.totalXp || Number(a.tokenId) - Number(b.tokenId),
  );

  const fresh = { at: Date.now(), value: entries };
  cacheHolder.__h00dchanLeaderboardCache = fresh;
  // Best-effort - a failed cache write means the next visitor just
  // recomputes too, same as today, never worth failing the request over.
  await redisCommand("SET", REDIS_CACHE_KEY, JSON.stringify(fresh)).catch(
    () => {},
  );
  return entries;
}
