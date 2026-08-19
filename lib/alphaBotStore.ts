// Alpha Bot research results - one entry per anon (tokenId), same
// counter/blob/ZSET pattern as lib/adStore.ts and lib/onlychansStore.ts.
// Reused for two reads: the owner's own wallet page (single entry by
// tokenId) and the public /alpha page's "recent research" list (the ZSET
// index, most recent first).
import { redisCommand } from "@/lib/store";

export interface AlphaBotEntry {
  tokenId: string;
  address: string; // the TBA address that was actually researched
  generatedAt: string;
  bullets: string[];
  totalValueUsd: number | null;
  labels: string[];
}

const INDEX_KEY = "alphabot:index";
const MAX_INDEX_SIZE = 200;

export async function getAlphaBotEntry(
  tokenId: string,
): Promise<AlphaBotEntry | null> {
  const raw = await redisCommand("GET", `alphabot:${tokenId}`);
  return typeof raw === "string" ? (JSON.parse(raw) as AlphaBotEntry) : null;
}

export async function saveAlphaBotEntry(entry: AlphaBotEntry): Promise<void> {
  await redisCommand("SET", `alphabot:${entry.tokenId}`, JSON.stringify(entry));
  await redisCommand(
    "ZADD",
    INDEX_KEY,
    Date.parse(entry.generatedAt),
    entry.tokenId,
  );
  // Bounded index, same reasoning as onlyChansStore's MAX_FEED_SIZE trim -
  // this is a "what's recent" list for the public /alpha page, not an
  // archive.
  await redisCommand("ZREMRANGEBYRANK", INDEX_KEY, 0, -MAX_INDEX_SIZE - 1);
}

export async function listRecentAlphaBotEntries(
  limit: number,
): Promise<AlphaBotEntry[]> {
  const tokenIds = (await redisCommand(
    "ZREVRANGE",
    INDEX_KEY,
    0,
    limit - 1,
  )) as string[];
  if (tokenIds.length === 0) return [];
  const entries = await Promise.all(tokenIds.map((id) => getAlphaBotEntry(id)));
  return entries.filter((e): e is AlphaBotEntry => e !== null);
}
