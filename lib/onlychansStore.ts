// onlyChans post storage - same shape as lib/adStore.ts (counter INCR for
// ids, one:<id> JSON blob, one:index ZSET for ordered listing), reusing
// lib/store.ts's redisCommand rather than a second Redis client.
import { redisCommand } from "@/lib/store";

export interface OnlyChanPost {
  id: string;
  imageUrl: string;
  prompt: string;
  createdAt: string;
}

const POST_INDEX_KEY = "onlychans:index";
const MAX_FEED_SIZE = 200;

async function nextPostId(): Promise<string> {
  const id = await redisCommand("INCR", "onlychans:counter");
  return String(id);
}

export async function createOnlyChanPost(
  input: Omit<OnlyChanPost, "id" | "createdAt">,
): Promise<OnlyChanPost> {
  const id = await nextPostId();
  const post: OnlyChanPost = {
    ...input,
    id,
    createdAt: new Date().toISOString(),
  };
  await redisCommand("SET", `onlychans:${id}`, JSON.stringify(post));
  await redisCommand("ZADD", POST_INDEX_KEY, Date.parse(post.createdAt), id);
  // Keep the index bounded - this is a satire meme feed, not an archive;
  // trimming the oldest entries out of the index caps both Redis growth
  // and the feed's own read cost, without needing a separate cleanup job.
  await redisCommand("ZREMRANGEBYRANK", POST_INDEX_KEY, 0, -MAX_FEED_SIZE - 1);
  return post;
}

export async function listOnlyChanPosts(
  limit = MAX_FEED_SIZE,
): Promise<OnlyChanPost[]> {
  const ids = (await redisCommand(
    "ZREVRANGE",
    POST_INDEX_KEY,
    0,
    limit - 1,
  )) as string[];
  if (ids.length === 0) return [];
  const raw = await Promise.all(
    ids.map((id) => redisCommand("GET", `onlychans:${id}`)),
  );
  return raw
    .map((r) =>
      typeof r === "string" ? (JSON.parse(r) as OnlyChanPost) : null,
    )
    .filter((p): p is OnlyChanPost => p !== null);
}
