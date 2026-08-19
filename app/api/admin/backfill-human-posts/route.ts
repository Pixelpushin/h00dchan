import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { listPosts, listThreads, redisCommand, type Post } from "@/lib/store";

// One-time backfill for the human-posts-by-token / human-threads-by-token
// indexes added so AI ghost-posts stop counting toward an anon's level -
// writePost()/createThread() only index NEW writes going forward, so
// every post/thread made before this shipped needs a retroactive walk, or
// every existing level (already shown live on the leaderboard/profile
// pages) would crater to near-zero the moment this deployed. Same
// two-pass, race-free pattern as backfill-posts-by-token: collect
// everything across all threads first, then write each token's lists
// once, rather than DEL-then-RPUSH interleaved with concurrent thread
// fetches (which would race if the same anon posted in two threads
// landing in the same concurrency batch).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THREAD_CONCURRENCY = 10;

async function handle(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const threads = await listThreads();
  const humanPostsByToken = new Map<string, Post[]>();
  const humanThreadsByToken = new Map<string, string[]>();

  for (let i = 0; i < threads.length; i += THREAD_CONCURRENCY) {
    const batch = threads.slice(i, i + THREAD_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (thread) => ({
        thread,
        posts: await listPosts(thread.id).catch(() => [] as Post[]),
      })),
    );
    for (const { thread, posts } of batchResults) {
      const op = posts[0];
      if (op && !op.isAi) {
        const list = humanThreadsByToken.get(thread.tokenId) ?? [];
        list.push(thread.id);
        humanThreadsByToken.set(thread.tokenId, list);
      }
      for (const post of posts) {
        if (post.isAi) continue;
        const list = humanPostsByToken.get(post.tokenId) ?? [];
        list.push(post);
        humanPostsByToken.set(post.tokenId, list);
      }
    }
  }

  let postsIndexed = 0;
  const postTokenIds = [...humanPostsByToken.keys()];
  for (let i = 0; i < postTokenIds.length; i += THREAD_CONCURRENCY) {
    const batch = postTokenIds.slice(i, i + THREAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (tokenId) => {
        const posts = humanPostsByToken
          .get(tokenId)!
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        await redisCommand("DEL", `human-posts-by-token:${tokenId}`);
        await redisCommand(
          "RPUSH",
          `human-posts-by-token:${tokenId}`,
          ...posts.map((p) => p.id),
        );
        postsIndexed += posts.length;
      }),
    );
  }

  let threadsIndexed = 0;
  const threadTokenIds = [...humanThreadsByToken.keys()];
  for (let i = 0; i < threadTokenIds.length; i += THREAD_CONCURRENCY) {
    const batch = threadTokenIds.slice(i, i + THREAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (tokenId) => {
        const threadIds = humanThreadsByToken.get(tokenId)!;
        await redisCommand("DEL", `human-threads-by-token:${tokenId}`);
        await redisCommand(
          "RPUSH",
          `human-threads-by-token:${tokenId}`,
          ...threadIds,
        );
        threadsIndexed += threadIds.length;
      }),
    );
  }

  return NextResponse.json({
    threadsScanned: threads.length,
    tokensWithHumanPosts: postTokenIds.length,
    postsIndexed,
    tokensWithHumanThreads: threadTokenIds.length,
    threadsIndexed,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
