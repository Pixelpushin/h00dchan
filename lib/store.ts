// Zero-dependency Upstash Redis REST client - same raw-fetch, path-style
// command encoding as hoodies-fight/api/_lib/redis.js (ported nearly
// verbatim), with one addition: an in-memory fallback for local dev, since
// no Upstash/Vercel KV project is wired up yet and KV_REST_API_URL/
// KV_REST_API_TOKEN won't be set. Once the Vercel KV integration is
// attached, those env vars appear automatically and this switches to real
// Redis with no code changes on either side - nothing here assumes a
// specific deployment target beyond reading those two env vars.
//
// Data model is deliberately thin - a handful of GET/SET/INCR/RPUSH/
// LRANGE/ZADD/ZREVRANGE calls, no query layer:
//   thread:counter          - INCR'd for sequential thread ids
//   post:counter            - INCR'd for sequential post ids (post numbers)
//   thread:<id>             - JSON-encoded Thread
//   post:<id>               - JSON-encoded Post
//   threads:index           - ZSET of thread ids, score = bumpedAt (ms)
//   posts:<threadId>        - LIST of post ids in reply order (OP first)
//   claimed:<tokenId>       - JSON-encoded ClaimRecord (address + claimedAt)
//   rarity-index             - JSON-encoded RarityIndex (whole-collection blob)
//   ai-last-post:<tokenId>  - ISO timestamp string, last AI post cooldown

// Stashed on globalThis, not a plain module-level `let`/`const`: Next.js
// (Turbopack in particular) compiles Server Components and Route Handlers
// into separate module graphs even though both run in the same Node
// process in dev - a plain module-scoped singleton silently ends up as two
// independent instances (verified live: a thread created via the
// /api/threads route handler was invisible to app/board/page.tsx's server
// component render of the same process until this was switched to
// globalThis). globalThis is one shared object across every module graph
// in the process, which is exactly what a same-process fallback needs.
import {
  fetchTokenMetadata,
  readOwnerOf,
  readTotalSupply,
  type TokenMetadata,
} from "@/lib/chain";

interface MemoryStoreGlobal {
  __h00dchanMemStore?: {
    strings: Map<string, string>;
    lists: Map<string, string[]>;
    zsets: Map<string, Map<string, number>>;
    sets: Map<string, Set<string>>;
    warnedFallback: boolean;
  };
}

const globalStore = globalThis as MemoryStoreGlobal;
if (!globalStore.__h00dchanMemStore) {
  globalStore.__h00dchanMemStore = {
    strings: new Map(),
    lists: new Map(),
    zsets: new Map(),
    sets: new Map(),
    warnedFallback: false,
  };
}
const memStore = globalStore.__h00dchanMemStore;

export async function redisCommand(
  cmd: string,
  ...args: Array<string | number>
): Promise<unknown> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    if (!memStore.warnedFallback) {
      memStore.warnedFallback = true;
      console.warn(
        "Redis not configured, using in-memory store - posts will not persist across restarts",
      );
    }
    return memoryCommand(
      cmd.toUpperCase(),
      args.map((a) => String(a)),
    );
  }

  // Path-style form (command + every arg as its own URL segment) - Upstash
  // rejects command-in-path + args-in-body for anything past a single arg.
  const path = [cmd, ...args]
    .map((s) => encodeURIComponent(String(s)))
    .join("/");
  const res = await fetch(`${url}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// --- In-memory fallback ---------------------------------------------------
// Mimics only the handful of Redis commands this module actually issues.
// Process-lifetime only, explicitly not meant to survive a restart - that
// trade-off is spelled out in the console.warn above. Backing maps live on
// `memStore` (globalThis-based, see above) rather than as plain module
// bindings.

function memoryCommand(cmd: string, args: string[]): unknown {
  const memStrings = memStore.strings;
  const memLists = memStore.lists;
  const memZsets = memStore.zsets;
  switch (cmd) {
    case "GET":
      return memStrings.get(args[0]) ?? null;
    case "SET":
      memStrings.set(args[0], args[1]);
      return "OK";
    case "INCR": {
      const next = (Number(memStrings.get(args[0])) || 0) + 1;
      memStrings.set(args[0], String(next));
      return next;
    }
    case "RPUSH": {
      const list = memLists.get(args[0]) ?? [];
      list.push(...args.slice(1));
      memLists.set(args[0], list);
      return list.length;
    }
    case "LRANGE": {
      const list = memLists.get(args[0]) ?? [];
      const start = Number(args[1]);
      const stop = Number(args[2]);
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    }
    case "LLEN":
      return (memLists.get(args[0]) ?? []).length;
    case "ZADD": {
      const zset = memZsets.get(args[0]) ?? new Map<string, number>();
      for (let i = 1; i < args.length; i += 2) {
        zset.set(args[i + 1], Number(args[i]));
      }
      memZsets.set(args[0], zset);
      return "OK";
    }
    case "ZREVRANGE": {
      const zset = memZsets.get(args[0]) ?? new Map<string, number>();
      const sorted = [...zset.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([member]) => member);
      const start = Number(args[1]);
      const stop = Number(args[2]);
      const end = stop === -1 ? sorted.length : stop + 1;
      return sorted.slice(start, end);
    }
    case "ZRANGEBYSCORE": {
      const zset = memZsets.get(args[0]) ?? new Map<string, number>();
      const min = Number(args[1]);
      const max = Number(args[2]);
      return [...zset.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }
    case "DEL": {
      let count = 0;
      for (const key of args) {
        if (memStrings.delete(key)) count += 1;
        if (memLists.delete(key)) count += 1;
        if (memZsets.delete(key)) count += 1;
      }
      return count;
    }
    case "ZREM": {
      const zset = memZsets.get(args[0]);
      if (!zset) return 0;
      let count = 0;
      for (const member of args.slice(1)) {
        if (zset.delete(member)) count += 1;
      }
      return count;
    }
    case "SADD": {
      const set = memStore.sets.get(args[0]) ?? new Set<string>();
      let added = 0;
      for (const member of args.slice(1)) {
        if (!set.has(member)) added += 1;
        set.add(member);
      }
      memStore.sets.set(args[0], set);
      return added;
    }
    case "SCARD":
      return (memStore.sets.get(args[0]) ?? new Set()).size;
    case "SMEMBERS":
      return [...(memStore.sets.get(args[0]) ?? new Set())];
    default:
      throw new Error(`In-memory store: unsupported command ${cmd}`);
  }
}

// --- Domain layer ----------------------------------------------------------

export interface Thread {
  id: string;
  subject: string;
  tokenId: string; // OP's token
  createdAt: string;
  bumpedAt: string;
}

export interface Post {
  id: string;
  threadId: string;
  tokenId: string;
  body: string;
  createdAt: string;
  // Only ever true for posts written via createAiPost/createAiReply below -
  // human posts (app/api/threads, app/api/threads/[threadId]/posts) never
  // set this. Rendered as a visible "(AI)" badge (see PostHeader) - the
  // whole point of this system is that AI authorship stays honest and
  // labeled, never passed off as a real holder's words.
  isAi?: boolean;
}

export interface ThreadWithCounts extends Thread {
  replyCount: number; // excludes the OP post itself
}

async function nextId(counterKey: string): Promise<string> {
  const id = await redisCommand("INCR", counterKey);
  return String(id);
}

async function readThread(id: string): Promise<Thread | null> {
  const raw = await redisCommand("GET", `thread:${id}`);
  return typeof raw === "string" ? (JSON.parse(raw) as Thread) : null;
}

async function writeThread(thread: Thread): Promise<void> {
  await redisCommand("SET", `thread:${thread.id}`, JSON.stringify(thread));
  await redisCommand(
    "ZADD",
    "threads:index",
    Date.parse(thread.bumpedAt),
    thread.id,
  );
}

async function writePost(post: Post): Promise<void> {
  await redisCommand("SET", `post:${post.id}`, JSON.stringify(post));
  await redisCommand("RPUSH", `posts:${post.threadId}`, post.id);
}

// Creates a thread and its OP post together - a thread with zero posts is
// not a meaningful state in this data model.
export async function createThread(
  subject: string,
  tokenId: string,
  body: string,
): Promise<{ thread: Thread; post: Post }> {
  const threadId = await nextId("thread:counter");
  const now = new Date().toISOString();
  const thread: Thread = {
    id: threadId,
    subject,
    tokenId,
    createdAt: now,
    bumpedAt: now,
  };
  await writeThread(thread);

  const postId = await nextId("post:counter");
  const post: Post = { id: postId, threadId, tokenId, body, createdAt: now };
  await writePost(post);

  return { thread, post };
}

// A thread is "human" if its OP post isn't isAi - checked directly against
// the OP post rather than a denormalized flag on Thread, since that works
// correctly on every thread ever created (including ones from before this
// check existed) with no migration needed.
export async function isThreadHuman(threadId: string): Promise<boolean> {
  const ids = (await redisCommand(
    "LRANGE",
    `posts:${threadId}`,
    0,
    0,
  )) as string[];
  const opId = ids[0];
  if (!opId) return false;
  const raw = await redisCommand("GET", `post:${opId}`);
  if (typeof raw !== "string") return false;
  const op = JSON.parse(raw) as Post;
  return op.isAi !== true;
}

export async function listThreads(): Promise<ThreadWithCounts[]> {
  const ids = (await redisCommand(
    "ZREVRANGE",
    "threads:index",
    0,
    -1,
  )) as string[];
  const threads = await Promise.all(
    ids.map(async (id) => {
      const thread = await readThread(id);
      if (!thread) return null;
      const postCount = (await redisCommand("LLEN", `posts:${id}`)) as number;
      return { ...thread, replyCount: Math.max(0, postCount - 1) };
    }),
  );
  return threads.filter((t): t is ThreadWithCounts => t !== null);
}

export async function getThread(id: string): Promise<Thread | null> {
  return readThread(id);
}

// Moderation primitive - removes a thread, every post in it, and its entry
// in the bump-order index. No soft-delete/audit trail; this is an MVP-scale
// admin action (see app/api/admin/threads/[threadId]/route.ts), not a full
// moderation system. Safe to call on a thread that's already gone (each
// DEL/ZREM is a no-op count, not an error).
export async function deleteThread(threadId: string): Promise<void> {
  const postIds = (await redisCommand(
    "LRANGE",
    `posts:${threadId}`,
    0,
    -1,
  )) as string[];
  if (postIds.length > 0) {
    await redisCommand("DEL", ...postIds.map((id) => `post:${id}`));
  }
  await redisCommand("DEL", `posts:${threadId}`, `thread:${threadId}`);
  await redisCommand("ZREM", "threads:index", threadId);
}

export async function addReply(
  threadId: string,
  tokenId: string,
  body: string,
): Promise<Post> {
  const postId = await nextId("post:counter");
  const now = new Date().toISOString();
  const post: Post = { id: postId, threadId, tokenId, body, createdAt: now };
  await writePost(post);

  const thread = await readThread(threadId);
  if (thread) {
    await writeThread({ ...thread, bumpedAt: now });
  }

  return post;
}

export async function listPosts(threadId: string): Promise<Post[]> {
  const ids = (await redisCommand(
    "LRANGE",
    `posts:${threadId}`,
    0,
    -1,
  )) as string[];
  const posts = await Promise.all(
    ids.map(async (id) => {
      const raw = await redisCommand("GET", `post:${id}`);
      return typeof raw === "string" ? (JSON.parse(raw) as Post) : null;
    }),
  );
  return posts.filter((p): p is Post => p !== null);
}

// --- Claim-state tracking ---------------------------------------------------
//
// "Claimed" means: the current on-chain owner of this tokenId has, at some
// point, proven it via verifyPersonaClaim (signature + live ownerOf check)
// and posted through the human write path. From that point on, AI posting
// for this token stops - a real person is speaking as this anon now.
//
// The claim record itself is NOT re-verified for ownership at write time -
// it just says "address X claimed tokenId Y at time Z". isTokenClaimed()
// below is what re-confirms X still holds Y *right now* before trusting a
// stale record, since claim state is tied to "this specific address
// currently owns this token", not "this token was claimed at some point in
// history". If the token sells, the old claim record is left in place
// un-deleted (harmless - isTokenClaimed will no longer trust it) and a
// future markTokenClaimed() call from the new owner overwrites it.

export interface ClaimRecord {
  address: string;
  claimedAt: string; // ISO timestamp
}

// Called from both write routes (app/api/threads/route.ts,
// app/api/threads/[threadId]/posts/route.ts) immediately after
// verifyPersonaClaim succeeds - by that point ownership has already been
// live-confirmed, so this just records the outcome.
const EVER_CLAIMED_SET_KEY = "claimed-tokens";

export async function markTokenClaimed(
  tokenId: string,
  address: string,
): Promise<void> {
  const record: ClaimRecord = { address, claimedAt: new Date().toISOString() };
  await redisCommand("SET", `claimed:${tokenId}`, JSON.stringify(record));
  // SADD is idempotent - re-claiming an already-claimed token (session
  // refresh, same holder posting again) doesn't double count. This tracks
  // "ever claimed at least once", not "currently claimed right now" (a
  // token that resold without the new owner reclaiming yet would still
  // count here even though isTokenClaimed() would say false for it) -
  // a fine approximation for a progress-bar stat, not a source of truth
  // for the actual AI-eligibility gate, which is what isTokenClaimed()
  // still is.
  await redisCommand("SADD", EVER_CLAIMED_SET_KEY, tokenId);
}

export interface ClaimStats {
  everClaimed: number;
  total: number;
}

export async function getClaimStats(): Promise<ClaimStats> {
  const [everClaimed, total] = await Promise.all([
    redisCommand("SCARD", EVER_CLAIMED_SET_KEY) as Promise<number>,
    // Live circulating supply, not a hardcoded 1200 - verified live that
    // this contract decrements totalSupply() on burn (currently 1198 after
    // 2 confirmed burns), so a hardcoded total would overcount denominator
    // forever as more burns happen.
    readTotalSupply(),
  ]);
  return { everClaimed: everClaimed ?? 0, total };
}

// Reads the claim record (if any) and, only if one exists, confirms via a
// live readOwnerOf() call that the recorded address still holds the token
// right now. No record at all -> not claimed, no chain call needed. A
// record whose address no longer matches the live owner -> treated as NOT
// claimed (AI posting resumes for the new, not-yet-claimed owner), even
// though the stale record is left on disk.
export async function isTokenClaimed(tokenId: string): Promise<boolean> {
  const raw = await redisCommand("GET", `claimed:${tokenId}`);
  if (typeof raw !== "string") return false;

  let record: ClaimRecord;
  try {
    record = JSON.parse(raw) as ClaimRecord;
  } catch {
    return false;
  }
  if (!record?.address) return false;

  try {
    const owner = await readOwnerOf(tokenId);
    return owner.toLowerCase() === record.address.toLowerCase();
  } catch {
    // Chain unavailable - fail closed toward NOT claimed would let the AI
    // post over a real claim during an RPC blip; fail toward claimed would
    // silently withhold AI posting during outages. Withholding is the
    // safer failure mode here (worst case: a quiet board during an RPC
    // hiccup, not a claimed anon getting spoken over), so treat chain
    // errors as "assume still claimed" when a record exists.
    return true;
  }
}

// --- Rarity index -----------------------------------------------------------
//
// Computed occasionally/offline by scripts/compute-rarity.ts (fetches all
// 1200 tokens' metadata, tallies trait-value frequency, scores each token by
// inverse-frequency-weighted rarity), then written here as one JSON blob -
// not recomputed per-request, which would mean fetching 1200 IPFS metadata
// documents on every request that needs a rarity check.

export interface RarityEntry {
  score: number;
  rank: number; // 1 = rarest
}

export interface RarityIndex {
  computedAt: string; // ISO timestamp
  totalSupply: number;
  entries: Record<string, RarityEntry>; // tokenId -> entry
}

const RARITY_INDEX_KEY = "rarity-index";

export async function writeRarityIndex(index: RarityIndex): Promise<void> {
  await redisCommand("SET", RARITY_INDEX_KEY, JSON.stringify(index));
}

export async function readRarityIndex(): Promise<RarityIndex | null> {
  const raw = await redisCommand("GET", RARITY_INDEX_KEY);
  return typeof raw === "string" ? (JSON.parse(raw) as RarityIndex) : null;
}

// Top ~5% rank counts as "rare". Doesn't block/crash if the index hasn't
// been computed yet (scripts/compute-rarity.ts hasn't been run against this
// store yet, e.g. fresh local dev with the in-memory fallback) - logs a
// warning once, same fallback-warning pattern as the in-memory Redis
// fallback above, and just treats every token as not-rare until the index
// exists.
const RARE_RANK_FRACTION = 0.05;
let warnedNoRarityIndex = false;

export async function isRareToken(tokenId: string): Promise<boolean> {
  const index = await readRarityIndex();
  if (!index) {
    if (!warnedNoRarityIndex) {
      warnedNoRarityIndex = true;
      console.warn(
        "Rarity index not computed yet (run `npx tsx scripts/compute-rarity.ts`) - treating all tokens as not-rare",
      );
    }
    return false;
  }
  const entry = index.entries[tokenId];
  if (!entry) return false;
  const rareThreshold = Math.max(
    1,
    Math.round(index.totalSupply * RARE_RANK_FRACTION),
  );
  return entry.rank <= rareThreshold;
}

// --- AI post cooldown --------------------------------------------------------
//
// Caps how often any single token can get a fresh AI-authored post - keeps
// Venice API cost bounded and stops the board from feeling like spam.
// Checked/set by app/api/ai/generate/route.ts around each generation.

export async function getAiLastPostAt(tokenId: string): Promise<string | null> {
  const raw = await redisCommand("GET", `ai-last-post:${tokenId}`);
  return typeof raw === "string" ? raw : null;
}

export async function setAiLastPostAt(
  tokenId: string,
  when: string = new Date().toISOString(),
): Promise<void> {
  await redisCommand("SET", `ai-last-post:${tokenId}`, when);
}

// --- AI-authored post writes -------------------------------------------------
//
// Distinct from createThread/addReply: no signature to verify (there's no
// wallet behind an AI post), so instead of verifyPersonaClaim these check
// isTokenClaimed() and refuse to write if a human has already claimed this
// token - the AI must never post over a real holder's identity. Every post
// written through here is stamped isAi: true (see Post interface above).

export class TokenClaimedError extends Error {
  constructor(tokenId: string) {
    super(`Token ${tokenId} is claimed by a human - refusing AI post.`);
    this.name = "TokenClaimedError";
  }
}

export async function createAiPost(
  subject: string,
  tokenId: string,
  body: string,
): Promise<{ thread: Thread; post: Post }> {
  if (await isTokenClaimed(tokenId)) {
    throw new TokenClaimedError(tokenId);
  }

  const threadId = await nextId("thread:counter");
  const now = new Date().toISOString();
  const thread: Thread = {
    id: threadId,
    subject,
    tokenId,
    createdAt: now,
    bumpedAt: now,
  };
  await writeThread(thread);

  const postId = await nextId("post:counter");
  const post: Post = {
    id: postId,
    threadId,
    tokenId,
    body,
    createdAt: now,
    isAi: true,
  };
  await writePost(post);

  return { thread, post };
}

export async function createAiReply(
  threadId: string,
  tokenId: string,
  body: string,
): Promise<Post> {
  if (await isTokenClaimed(tokenId)) {
    throw new TokenClaimedError(tokenId);
  }

  const postId = await nextId("post:counter");
  const now = new Date().toISOString();
  const post: Post = {
    id: postId,
    threadId,
    tokenId,
    body,
    createdAt: now,
    isAi: true,
  };
  await writePost(post);

  const thread = await readThread(threadId);
  if (thread) {
    await writeThread({ ...thread, bumpedAt: now });
  }

  return post;
}

// --- Token metadata cache ----------------------------------------------
//
// HOODCHAN's metadata/art lives on IPFS, resolved through public gateways
// (lib/chain.ts's fetchTokenMetadata) - those gateways are observably
// flaky/rate-limited under real traffic (verified live: repeated 502s on
// app/api/token/[tokenId] for a token that resolved fine moments later).
// The HTTP Cache-Control header on that route doesn't actually help -
// it's a force-dynamic Node serverless function, which Vercel's edge
// doesn't cache regardless of the header - so every page load was hitting
// IPFS fresh, for every user, forever. Since a token's metadata is
// immutable once minted, cache it here permanently (no TTL) once resolved
// successfully: after the first successful resolution of any given token,
// no request from any user ever needs to touch IPFS for it again.
const TOKEN_META_PREFIX = "token-meta:";

export async function getCachedTokenMetadata(
  tokenId: string,
): Promise<TokenMetadata | null> {
  const raw = await redisCommand("GET", `${TOKEN_META_PREFIX}${tokenId}`);
  return typeof raw === "string" ? (JSON.parse(raw) as TokenMetadata) : null;
}

export async function cacheTokenMetadata(
  tokenId: string,
  metadata: TokenMetadata,
): Promise<void> {
  await redisCommand(
    "SET",
    `${TOKEN_META_PREFIX}${tokenId}`,
    JSON.stringify(metadata),
  );
}

// The one function every caller should actually use - checks the cache,
// falls back to a live IPFS fetch on miss, and populates the cache on
// success. app/api/token/[tokenId]/route.ts (client-side token grid) and
// app/board/[threadId]/page.tsx (server-rendered post images) both need
// this same resolution; the thread page originally called
// fetchTokenMetadata() directly, bypassing the cache entirely - every
// thread view was re-hitting IPFS live for every post's token, which is
// almost certainly the real source of reported page-load lag, not just
// the metadata-route 502s. Import fetchTokenMetadata dynamically-by-name
// isn't needed here; both modules already sit in the same server bundle.
export async function getOrFetchTokenMetadata(
  tokenId: string,
): Promise<TokenMetadata> {
  const cached = await getCachedTokenMetadata(tokenId).catch(() => null);
  if (cached) return cached;

  const metadata = await fetchTokenMetadata(tokenId);
  await cacheTokenMetadata(tokenId, metadata).catch((err) => {
    console.error(`Failed to cache metadata for HOODCHAN #${tokenId}`, err);
  });
  return metadata;
}

// --- In-app notification badge -------------------------------------------
//
// "Did my thread get a new reply" badge on the wallet header widget. Keyed
// by wallet address, not tokenId - a holder can own several tokens and
// this is one badge for "any of your stuff got activity", not per-token.
// Deliberately just one timestamp per address rather than per-thread read
// state: simple, and the only actions that move it are "connect a wallet"
// (implicit - never seen before) and "open the wallet menu" (explicit
// mark-read) - see app/api/notifications/route.ts.
const NOTIF_LAST_SEEN_PREFIX = "notif-last-seen:";

export async function getNotifLastSeen(
  address: string,
): Promise<string | null> {
  const raw = await redisCommand(
    "GET",
    `${NOTIF_LAST_SEEN_PREFIX}${address.toLowerCase()}`,
  );
  return typeof raw === "string" ? raw : null;
}

export async function setNotifLastSeen(address: string): Promise<void> {
  await redisCommand(
    "SET",
    `${NOTIF_LAST_SEEN_PREFIX}${address.toLowerCase()}`,
    new Date().toISOString(),
  );
}
