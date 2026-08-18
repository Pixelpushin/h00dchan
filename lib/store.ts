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
//   posts-by-token:<tokenId> - LIST of every post id an anon has ever made,
//                              across every thread, oldest first (profile
//                              page post history)
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

  // No timeout + no retry here used to mean a single transient Upstash
  // blip (or a request that just hangs) threw all the way up to whatever
  // called redisCommand - and nearly every caller in this file wraps its
  // reads in `.catch(() => [])`/`.catch(() => null)` for legitimate reasons
  // (an empty board section isn't worth a hard error page), which silently
  // turned "Redis had a bad moment" into "this thread/section just doesn't
  // exist," with no trace anywhere. Confirmed live in production: the RSC
  // payload for a real page load showed both PopularThreads and
  // HumanThreads rendering to null despite 330 real threads existing -
  // listThreads() had thrown and been swallowed. One retry after a short
  // timeout turns a one-off blip into a ~seconds-long delay instead of a
  // vanished section; a genuinely down Redis still throws for real after
  // both attempts fail, same as before.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${url}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result;
    } catch (error) {
      lastError = error;
      console.error(
        `redisCommand ${cmd} failed (attempt ${attempt + 1}/2)`,
        error,
      );
    }
  }
  throw lastError;
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
    case "LREM": {
      // Only the "count 0" form (remove every match) is used anywhere in
      // this codebase - args[1] is accepted but ignored rather than
      // implementing Redis's full positive/negative-count semantics for a
      // command with exactly one caller.
      const list = memLists.get(args[0]) ?? [];
      const target = args[2];
      const next = list.filter((item) => item !== target);
      memLists.set(args[0], next);
      return list.length - next.length;
    }
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
  await redisCommand("RPUSH", `posts-by-token:${post.tokenId}`, post.id);
  // Separate human-only index for leveling (lib/leveling.ts) - an
  // unclaimed anon's AI ghost-posts must never earn it XP, only what its
  // real holder actually writes. Cheap to maintain (one more RPUSH at the
  // same write site every post already goes through) vs. filtering by
  // isAi at read time, which would mean fetching and inspecting every
  // post just to count them - exactly the kind of per-request fan-out
  // this session already root-caused and fixed once for a different
  // feature.
  if (!post.isAi) {
    await redisCommand(
      "RPUSH",
      `human-posts-by-token:${post.tokenId}`,
      post.id,
    );
  }
  invalidateListThreadsCache();
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
  // Human-thread tracking for leveling (lib/leveling.ts) - this is the
  // one function only a real human-authored thread ever goes through
  // (createAiPost is the AI's equivalent, deliberately not tracked here).
  await redisCommand("RPUSH", `human-threads-by-token:${tokenId}`, threadId);

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

// Every thread needs 2 Redis calls (GET the thread, LLEN its post list) -
// firing all of them at once via a single unbounded Promise.all was
// verified live to cause the home page's TTFB to swing from ~1s to ~9s:
// with ~330 threads that's up to 660 simultaneous REST calls to Upstash in
// one burst, and if even one straggler gets throttled, the whole
// Promise.all (and therefore the whole page) waits on redisCommand's
// retry/timeout (up to 16s) for that one call. Chunking bounds the burst
// size instead of removing concurrency entirely - same pattern as
// lib/chain.ts's OWNERSHIP_CHECK_CONCURRENCY for the same class of problem
// against a different flaky-under-load API.
const THREAD_FETCH_CONCURRENCY = 20;

// Short shared cache, not a source of truth - collapses the burst of
// concurrent home/board page loads that would otherwise each independently
// re-run the full per-thread scan above into one shared fetch. 5s is long
// enough to matter under real traffic, short enough that a freshly posted
// thread still appears within one page reload for everyone else.
const LIST_THREADS_CACHE_MS = 5_000;
interface ListThreadsCacheGlobal {
  __h00dchanListThreadsCache?: { at: number; value: ThreadWithCounts[] } | null;
}
const listThreadsCacheHolder = globalThis as ListThreadsCacheGlobal;

// Called from every write path that changes what listThreads() would
// return (new thread, new reply changing a replyCount, a deletion) - keeps
// the cache from serving stale data to the person who just posted, while
// still collapsing concurrent reads from everyone else in between writes.
function invalidateListThreadsCache(): void {
  listThreadsCacheHolder.__h00dchanListThreadsCache = null;
}

export async function listThreads(): Promise<ThreadWithCounts[]> {
  const cached = listThreadsCacheHolder.__h00dchanListThreadsCache;
  if (cached && Date.now() - cached.at < LIST_THREADS_CACHE_MS) {
    return cached.value;
  }

  const ids = (await redisCommand(
    "ZREVRANGE",
    "threads:index",
    0,
    -1,
  )) as string[];

  const threads: (ThreadWithCounts | null)[] = [];
  for (let i = 0; i < ids.length; i += THREAD_FETCH_CONCURRENCY) {
    const batch = ids.slice(i, i + THREAD_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        const thread = await readThread(id);
        if (!thread) return null;
        const postCount = (await redisCommand("LLEN", `posts:${id}`)) as number;
        return { ...thread, replyCount: Math.max(0, postCount - 1) };
      }),
    );
    threads.push(...batchResults);
  }

  const result = threads.filter((t): t is ThreadWithCounts => t !== null);
  listThreadsCacheHolder.__h00dchanListThreadsCache = {
    at: Date.now(),
    value: result,
  };
  return result;
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
  invalidateListThreadsCache();
}

export class CannotDeleteOpError extends Error {
  constructor(threadId: string) {
    super(
      `Post is the OP of thread ${threadId} - delete the whole thread instead.`,
    );
    this.name = "CannotDeleteOpError";
  }
}

// Moderation primitive for a single bad reply (e.g. a stray off-topic AI
// generation) without nuking the whole thread around it - deleteThread
// above is the only removal tool that existed before this, which is too
// blunt when the thread itself (and its other posts) are fine. Refuses to
// remove the OP itself: a thread with no OP is a broken state this data
// model doesn't otherwise support (see createThread's own comment on why a
// thread and its OP post are always created together) - deleteThread is
// the correct tool for "the whole thread needs to go."
export async function deletePost(
  threadId: string,
  postId: string,
): Promise<void> {
  const opIds = (await redisCommand(
    "LRANGE",
    `posts:${threadId}`,
    0,
    0,
  )) as string[];
  if (opIds[0] === postId) {
    throw new CannotDeleteOpError(threadId);
  }
  await redisCommand("LREM", `posts:${threadId}`, 0, postId);
  await redisCommand("DEL", `post:${postId}`);
  invalidateListThreadsCache();
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

export interface PostWithThreadSubject extends Post {
  threadSubject: string | null;
}

// Profile page post history - newest first, capped rather than the full
// list (an active anon could rack up hundreds of posts; the profile only
// ever shows a preview, not a full archive). Reads posts-by-token's LIST
// directly rather than scanning listThreads()/listPosts() per-thread the
// way an ad-hoc lookup would - that's exactly the unbounded-fan-out shape
// this session already found and fixed once for the home page's Redis
// load, no reason to reintroduce the same class of bug here.
export async function listPostsByToken(
  tokenId: string,
  limit = 20,
): Promise<PostWithThreadSubject[]> {
  const ids = (await redisCommand(
    "LRANGE",
    `posts-by-token:${tokenId}`,
    -limit,
    -1,
  )) as string[];
  const posts = await Promise.all(
    ids.map(async (id) => {
      const raw = await redisCommand("GET", `post:${id}`);
      if (typeof raw !== "string") return null;
      const post = JSON.parse(raw) as Post;
      const thread = await readThread(post.threadId);
      return { ...post, threadSubject: thread?.subject ?? null };
    }),
  );
  return posts.filter((p): p is PostWithThreadSubject => p !== null).reverse(); // oldest-first LIST -> newest-first for display
}

// Cheap total count for a profile page stat ("posted N times") without
// resolving every post body - LLEN is O(1) in Redis regardless of list
// size, unlike listPostsByToken's per-post GET fan-out above.
export async function countPostsByToken(tokenId: string): Promise<number> {
  const count = await redisCommand("LLEN", `posts-by-token:${tokenId}`);
  return typeof count === "number" ? count : 0;
}

// Human-authored posts only - see writePost's human-posts-by-token
// comment. Used for leveling (lib/leveling.ts), not for the profile
// page's "N posts" display count, which intentionally still shows every
// post (AI-authored history included) as real activity on that anon.
export async function countHumanPostsByToken(tokenId: string): Promise<number> {
  const count = await redisCommand("LLEN", `human-posts-by-token:${tokenId}`);
  return typeof count === "number" ? count : 0;
}

// Human-started threads only - tracked explicitly at the one place a
// human actually starts a thread (createThread below), not derived from
// scanning threads and checking each OP post's isAi flag (would mean an
// extra read per candidate thread just to answer "did a human start
// this").
export async function countHumanThreadsByToken(
  tokenId: string,
): Promise<number> {
  const count = await redisCommand("LLEN", `human-threads-by-token:${tokenId}`);
  return typeof count === "number" ? count : 0;
}

export interface RecentPost extends Post {
  threadSubject: string;
}

// Every post board-wide created since `sinceMs` - backs the daily alpha
// digest (lib/dailyAlpha.ts). Pre-filters on listThreads()'s bumpedAt
// before walking any thread's posts - a thread that hasn't been bumped
// since the cutoff can't contain a post newer than the cutoff either
// (bumpedAt is always >= every post's createdAt in that thread), so this
// skips fetching posts for threads that are definitely all-old instead of
// listing and filtering every thread on the board.
export async function listRecentPosts(sinceMs: number): Promise<RecentPost[]> {
  const threads = await listThreads();
  const candidates = threads.filter((t) => Date.parse(t.bumpedAt) >= sinceMs);
  const perThread = await Promise.all(
    candidates.map(async (thread) => {
      const posts = await listPosts(thread.id);
      return posts
        .filter((p) => Date.parse(p.createdAt) >= sinceMs)
        .map((p) => ({ ...p, threadSubject: thread.subject }));
    }),
  );
  return perThread.flat();
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
  // Reverse index for the header identity switcher (WalletHeaderWidget) -
  // "which anons has THIS address ever claimed" without scanning every
  // claimed token's record. Same "ever", not "currently", caveat as
  // EVER_CLAIMED_SET_KEY above; listMyClaimedTokens() re-checks each
  // candidate's actual stored record before trusting it, so a resold
  // token doesn't linger in someone's switcher forever.
  await redisCommand(
    "SADD",
    `claimed-by-address:${address.toLowerCase()}`,
    tokenId,
  );
}

// Candidates for "your other anons" in the header switcher - re-verifies
// each candidate's CURRENT stored claim record still points at this
// address (not just "ever did"), so a token that got resold since drops
// out instead of lingering as a stale switcher entry. Doesn't re-check
// live on-chain ownership (isTokenClaimed does that, for the actual
// AI-eligibility gate) - this is a convenience list, not a security
// boundary, and the switch itself still requires a real signature.
export async function listMyClaimedTokens(address: string): Promise<string[]> {
  const candidates = (await redisCommand(
    "SMEMBERS",
    `claimed-by-address:${address.toLowerCase()}`,
  )) as string[];
  const checks = await Promise.all(
    candidates.map(async (tokenId) => {
      const raw = await redisCommand("GET", `claimed:${tokenId}`);
      if (typeof raw !== "string") return null;
      try {
        const record = JSON.parse(raw) as ClaimRecord;
        return record.address?.toLowerCase() === address.toLowerCase()
          ? tokenId
          : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((id): id is string => id !== null);
}

// Leaderboard candidate set - tokens worth checking for a real level at
// all. Not "currently claimed" (that's isTokenClaimed, a live on-chain
// re-check per token) - this is the cheap, already-indexed "has this
// token ever shown any sign of life" set.
export async function listEverClaimedTokenIds(): Promise<string[]> {
  return (await redisCommand("SMEMBERS", EVER_CLAIMED_SET_KEY)) as string[];
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

// --- Daily alpha digest ----------------------------------------------------
//
// One Venice-summarized digest of the last 24h of board activity, split
// into clearly-labeled human vs. AI-shitpost sections (see
// lib/dailyAlpha.ts for the actual summarization). Single "latest" key,
// not a history log - each generation overwrites the last one, same
// throwaway-freshness model as everything else this board treats as a
// point-in-time snapshot rather than an archive.

export interface DailyAlphaDigest {
  generatedAt: string; // ISO timestamp
  humanBullets: string[];
  aiBullets: string[];
}

const DAILY_ALPHA_KEY = "daily-alpha:latest";

export async function getDailyAlphaDigest(): Promise<DailyAlphaDigest | null> {
  const raw = await redisCommand("GET", DAILY_ALPHA_KEY);
  return typeof raw === "string" ? (JSON.parse(raw) as DailyAlphaDigest) : null;
}

export async function setDailyAlphaDigest(
  digest: DailyAlphaDigest,
): Promise<void> {
  await redisCommand("SET", DAILY_ALPHA_KEY, JSON.stringify(digest));
}
