// Alpha Bot research results - one entry per anon (tokenId), same
// counter/blob/ZSET pattern as lib/adStore.ts and lib/onlychansStore.ts.
// Reused for two reads: the owner's own wallet page (single entry by
// tokenId) and the public /alpha page's "recent research" list (the ZSET
// index, most recent first).
import { redisCommand } from "@/lib/store";

// A "desk" is one voice in the trade-room framing (Research/Risk/Skeptic -
// see lib/alphaBotResearch.ts) - each grounded in the exact same real
// Nansen pull, just narrating/cross-checking it from a different angle,
// not a separate data fetch per desk.
export interface AlphaDesk {
  name: string;
  bullets: string[];
}

export interface AlphaBotEntry {
  tokenId: string;
  address: string; // the TBA address that was actually researched
  generatedAt: string;
  desks: AlphaDesk[];
  // Flattened view of every desk's bullets in order - kept for the
  // existing wallet-page/​/alpha-page display, which doesn't need the
  // desk structure, just the content.
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

const DAILY_BUDGET_PREFIX = "alphabot:daily-events:";

// Atomic site-wide daily budget for Alpha Bot reply-posting EVENTS (see
// lib/alphaBotConfig.ts's MAX_ALPHA_BOT_EVENTS_PER_DAY for what counts as
// one event). Redis INCR is atomic, so the count this call returns is
// correct even if two triggers land in the same instant - there's no
// separate "check then increment" race window. Key is day-bucketed
// (UTC date string) rather than using an explicit reset job; a 2-day
// EXPIRE keeps old day-keys from accumulating forever.
export async function consumeDailyAlphaBotBudget(
  maxPerDay: number,
): Promise<boolean> {
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${DAILY_BUDGET_PREFIX}${dayKey}`;
  const count = (await redisCommand("INCR", key)) as number;
  if (count === 1) {
    await redisCommand("EXPIRE", key, 172_800);
  }
  return count <= maxPerDay;
}

const LABELS_CACHE_PREFIX = "alphabot:labels:";
const LABELS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CachedLabels {
  labels: string[];
  fetchedAt: string;
}

// Confirmed live via response headers: Nansen's address-labels endpoint
// costs 100 credits/call, a hundred times the 1 credit the balances
// endpoint costs - re-fetching it on the same 24h cadence as balances
// would burn a whole month's starter credit allotment (2,000) in about 4
// days at the site-wide daily event cap. An address's entity/behavioral
// labels also don't change nearly as often as its balances do, so a much
// longer cache is both cheaper AND still accurate - this is the dominant
// lever on whether Alpha Bot is financially viable to keep running, not a
// premature optimization.
export async function getCachedLabels(
  address: string,
): Promise<string[] | null> {
  const raw = await redisCommand(
    "GET",
    `${LABELS_CACHE_PREFIX}${address.toLowerCase()}`,
  );
  if (typeof raw !== "string") return null;
  const cached = JSON.parse(raw) as CachedLabels;
  if (Date.now() - Date.parse(cached.fetchedAt) > LABELS_CACHE_TTL_MS) {
    return null;
  }
  return cached.labels;
}

export async function saveCachedLabels(
  address: string,
  labels: string[],
): Promise<void> {
  const cached: CachedLabels = { labels, fetchedAt: new Date().toISOString() };
  await redisCommand(
    "SET",
    `${LABELS_CACHE_PREFIX}${address.toLowerCase()}`,
    JSON.stringify(cached),
  );
}
