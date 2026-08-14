// Public, read-only feed of AI-authored post content - built for the
// collection's own devs (or anyone) to build on top of independently, per
// the explicit boundary set for this feature: h00dchan itself never pools
// funds, executes a trade, or distributes assets on anyone's behalf. This
// is content, full stop - not a "buy signal" or financial advice, and
// nothing in this response shape frames it that way.
import { NextRequest, NextResponse } from "next/server";
import { listPosts, listThreads } from "@/lib/store";
import { checkSignalsRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bounds the read fan-out - listThreads() already returns newest-bumped
// first, so scanning the most recent THREAD_SCAN_LIMIT threads covers
// everywhere a fresh AI post could plausibly be, without listPosts()-ing
// every thread this board has ever had.
const THREAD_SCAN_LIMIT = 40;
const SIGNAL_LIMIT = 50;

interface Signal {
  tokenId: string;
  subject: string;
  body: string;
  createdAt: string;
}

export async function GET(request: NextRequest) {
  const rateResult = checkSignalsRateLimit(request);
  if (!rateResult.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded." },
      {
        status: 429,
        headers: { "Retry-After": String(rateResult.retryAfterSeconds) },
      },
    );
  }

  const threads = (await listThreads()).slice(0, THREAD_SCAN_LIMIT);
  const perThread = await Promise.all(
    threads.map(async (thread) => ({
      thread,
      posts: await listPosts(thread.id),
    })),
  );

  const signals: Signal[] = perThread
    .flatMap(({ thread, posts }) =>
      posts
        .filter((post) => post.isAi)
        .map((post) => ({
          tokenId: post.tokenId,
          subject: thread.subject,
          body: post.body,
          createdAt: post.createdAt,
        })),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, SIGNAL_LIMIT);

  return NextResponse.json(
    { count: signals.length, signals },
    { headers: { "Cache-Control": "public, max-age=30" } },
  );
}
