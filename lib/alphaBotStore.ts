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
  // The actual holder's own wallet (current owner of this anon), also
  // researched alongside the TBA above - null when it's the same address
  // (shouldn't happen structurally) or genuinely couldn't be resolved.
  // See lib/alphaBotResearch.ts's generateAlphaBotResearch.
  holderAddress: string | null;
  generatedAt: string;
  desks: AlphaDesk[];
  // Flattened view of every desk's bullets in order - kept for the
  // existing wallet-page/​/alpha-page display, which doesn't need the
  // desk structure, just the content.
  bullets: string[];
  totalValueUsd: number | null;
  labels: string[];
  // Venice's own judgment, made alongside the desk research (same call, no
  // extra spend): is this specific finding genuinely notable enough to
  // headline its own new thread (aixbt-style - see lib/alphaBotConfig.ts's
  // ALPHA_BOT_NEW_THREAD_COOLDOWN_DAYS)? null on a cache-hit reuse (the
  // judgment isn't re-run against stale data) or when generation skipped
  // entirely (nothing to research). threadStarted records whether this
  // specific entry actually got to post its own thread - kept even after
  // the fact so re-displaying this same cached entry elsewhere never
  // implies "and here's a new thread" a second time.
  newsworthy: { subject: string; body: string } | null;
  threadStarted: boolean;
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

const DAILY_TOKEN_POST_PREFIX = "alphabot:daily-posts:";

// Per-anon daily posting cap, same atomic day-bucketed INCR shape as
// consumeDailyAlphaBotBudget above, just keyed per tokenId instead of
// site-wide - see lib/alphaBotConfig.ts's MAX_ALPHA_BOT_POSTS_PER_TOKEN_PER_DAY
// for why this exists (a cache-hit event costs zero real spend, so the
// site-wide budget alone doesn't cap how often one anon can post).
export async function consumeDailyAlphaBotPostCap(
  tokenId: string,
  maxPerDay: number,
): Promise<boolean> {
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${DAILY_TOKEN_POST_PREFIX}${dayKey}:${tokenId}`;
  const count = (await redisCommand("INCR", key)) as number;
  if (count === 1) {
    await redisCommand("EXPIRE", key, 172_800);
  }
  return count <= maxPerDay;
}

const GENERATION_LOCK_PREFIX = "alphabot:generating:";
const GENERATION_LOCK_TTL_SECONDS = 45; // covers one full generateAlphaBotResearch call with margin - self-expires rather than deadlocking if a process dies mid-generation

// Real race, not just theoretical: two near-simultaneous triggers for the
// SAME tokenId (two browser tabs, or a thread-create landing right next to
// a reply in the same thread) can both read "no fresh cache entry" before
// either one finishes writing its result, causing two full Nansen+Venice
// generations - two Nansen credit spends and two daily-budget slots burned
// for what the user experiences as one action. SET...NX is atomic in
// Redis, so only one concurrent caller for a given tokenId ever gets
// `true` back; the other should treat "someone else is already generating
// this" as equivalent to a cache-miss-but-can't-proceed and skip rather
// than double-generate. Note: the in-memory fallback (no KV_REST_API_URL
// configured) does NOT implement NX semantics - see lib/store.ts's
// memoryCommand SET case, which always succeeds - so this lock is only a
// real guarantee against production's actual Redis; acceptable since that
// fallback path is single-process dev/local use already, not the
// concurrent-request production path this race matters for.
export async function acquireAlphaBotGenerationLock(
  tokenId: string,
): Promise<boolean> {
  const result = await redisCommand(
    "SET",
    `${GENERATION_LOCK_PREFIX}${tokenId}`,
    "1",
    "NX",
    "EX",
    GENERATION_LOCK_TTL_SECONDS,
  );
  return result === "OK";
}

const NEW_THREAD_COOLDOWN_KEY = "alphabot:new-thread-cooldown";

// Site-wide gate on Alpha Bot's new-thread privilege (see
// lib/alphaBotConfig.ts's ALPHA_BOT_NEW_THREAD_COOLDOWN_DAYS) - same
// SET...NX...EX atomic-lock shape as acquireAlphaBotGenerationLock above,
// just with a multi-day TTL instead of a 45s one. Returns true only for
// the caller that "wins" and may actually post the new thread; every other
// qualifying anon's research within the cooldown window sees false and
// just... doesn't get its own thread this time, no matter how notable its
// own findings are. One fixed key, not per-anon - the cooldown is meant to
// cap the SITE's total cadence of AI-started threads, not give each anon
// its own independent allowance.
export async function consumeAlphaBotNewThreadCooldown(
  cooldownDays: number,
): Promise<boolean> {
  const result = await redisCommand(
    "SET",
    NEW_THREAD_COOLDOWN_KEY,
    "1",
    "NX",
    "EX",
    cooldownDays * 24 * 60 * 60,
  );
  return result === "OK";
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
