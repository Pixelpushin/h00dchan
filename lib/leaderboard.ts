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
  countPostsByToken,
} from "@/lib/store";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import { computeLevelProgress, type LevelProgress } from "@/lib/leveling";

export interface LeaderboardEntry {
  tokenId: string;
  level: number;
  totalXp: number;
  claimed: boolean;
  walletActivated: boolean;
}

const CANDIDATE_CONCURRENCY = 10;
const CACHE_MS = 60_000;

interface LeaderboardCacheGlobal {
  __h00dchanLeaderboardCache?: { at: number; value: LeaderboardEntry[] } | null;
}
const cacheHolder = globalThis as LeaderboardCacheGlobal;

export async function computeLeaderboard(): Promise<LeaderboardEntry[]> {
  const cached = cacheHolder.__h00dchanLeaderboardCache;
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }

  const [everClaimed, threads] = await Promise.all([
    listEverClaimedTokenIds(),
    listThreads(),
  ]);

  const threadsStartedByToken = new Map<string, number>();
  for (const thread of threads) {
    threadsStartedByToken.set(
      thread.tokenId,
      (threadsStartedByToken.get(thread.tokenId) ?? 0) + 1,
    );
  }

  const candidateIds = new Set<string>(everClaimed);
  for (const tokenId of threadsStartedByToken.keys()) candidateIds.add(tokenId);
  const candidates = [...candidateIds];

  const entries: LeaderboardEntry[] = [];
  for (let i = 0; i < candidates.length; i += CANDIDATE_CONCURRENCY) {
    const batch = candidates.slice(i, i + CANDIDATE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (tokenId): Promise<LeaderboardEntry | null> => {
        try {
          const tbaAddress = await computeTbaAddress(tokenId);
          const [claimed, walletActivated, totalPosts] = await Promise.all([
            isTokenClaimed(tokenId).catch(() => false),
            isTbaActivated(tbaAddress).catch(() => false),
            countPostsByToken(tokenId).catch(() => 0),
          ]);
          const progress: LevelProgress = computeLevelProgress({
            claimed,
            walletActivated,
            threadsStarted: threadsStartedByToken.get(tokenId) ?? 0,
            totalPosts,
          });
          return {
            tokenId,
            level: progress.level,
            totalXp: progress.totalXp,
            claimed,
            walletActivated,
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

  cacheHolder.__h00dchanLeaderboardCache = { at: Date.now(), value: entries };
  return entries;
}
