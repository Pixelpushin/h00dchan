import { NextRequest, NextResponse } from "next/server";
import { listPosts, listThreads, redisCommand, type Post } from "@/lib/store";

// One-time backfill for the posts-by-token index (added for the anon
// profile page's post history) - writePost() only indexes NEW posts going
// forward, so every post made before this shipped needs a single
// retroactive walk. Two passes on purpose: collect every post across every
// thread first, THEN write each token's list once. Writing per-thread as
// threads are scanned (DEL-then-RPUSH interleaved with concurrent thread
// fetches) would race if the same anon posted in two threads landing in
// the same concurrency batch - one thread's DEL could wipe out the other's
// RPUSH mid-flight. Collecting first avoids that entirely, and a single
// RPUSH per token (all post ids as one call) means each token's list is
// idempotent and race-free to rebuild, safe to re-run if interrupted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THREAD_CONCURRENCY = 10;

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const threads = await listThreads();
  const postsByToken = new Map<string, Post[]>();

  for (let i = 0; i < threads.length; i += THREAD_CONCURRENCY) {
    const batch = threads.slice(i, i + THREAD_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((thread) => listPosts(thread.id).catch(() => [] as Post[])),
    );
    for (const posts of batchResults) {
      for (const post of posts) {
        const existing = postsByToken.get(post.tokenId);
        if (existing) existing.push(post);
        else postsByToken.set(post.tokenId, [post]);
      }
    }
  }

  let postsIndexed = 0;
  const tokenIds = [...postsByToken.keys()];
  for (let i = 0; i < tokenIds.length; i += THREAD_CONCURRENCY) {
    const batch = tokenIds.slice(i, i + THREAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (tokenId) => {
        const posts = postsByToken
          .get(tokenId)!
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        await redisCommand("DEL", `posts-by-token:${tokenId}`);
        await redisCommand(
          "RPUSH",
          `posts-by-token:${tokenId}`,
          ...posts.map((p) => p.id),
        );
        postsIndexed += posts.length;
      }),
    );
  }

  return NextResponse.json({
    threadsScanned: threads.length,
    tokensIndexed: tokenIds.length,
    postsIndexed,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
