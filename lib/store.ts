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

// Stashed on globalThis, not a plain module-level `let`/`const`: Next.js
// (Turbopack in particular) compiles Server Components and Route Handlers
// into separate module graphs even though both run in the same Node
// process in dev - a plain module-scoped singleton silently ends up as two
// independent instances (verified live: a thread created via the
// /api/threads route handler was invisible to app/board/page.tsx's server
// component render of the same process until this was switched to
// globalThis). globalThis is one shared object across every module graph
// in the process, which is exactly what a same-process fallback needs.
interface MemoryStoreGlobal {
  __h00dchanMemStore?: {
    strings: Map<string, string>;
    lists: Map<string, string[]>;
    zsets: Map<string, Map<string, number>>;
    warnedFallback: boolean;
  };
}

const globalStore = globalThis as MemoryStoreGlobal;
if (!globalStore.__h00dchanMemStore) {
  globalStore.__h00dchanMemStore = {
    strings: new Map(),
    lists: new Map(),
    zsets: new Map(),
    warnedFallback: false,
  };
}
const memStore = globalStore.__h00dchanMemStore;

async function redisCommand(
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
