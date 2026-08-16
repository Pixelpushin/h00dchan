import { NextRequest, NextResponse, after } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { addReply, getThread, listPosts, markTokenClaimed } from "@/lib/store";
import { triggerAiReply } from "@/lib/aiEngagement";
import {
  claimRewardSlot,
  REWARD_REPLY_COUNT,
  REWARD_WINDOW_MS,
  scheduleStaggeredReplies,
} from "@/lib/scheduledReplies";
import { scoreThreadQuality } from "@/lib/threadQuality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_LEN = 4000;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  try {
    const thread = await getThread(threadId);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found." }, { status: 404 });
    }
    const posts = await listPosts(threadId);
    return NextResponse.json({ thread, posts });
  } catch (error) {
    console.error(`Failed to list posts for thread ${threadId}`, error);
    return NextResponse.json(
      { error: "Unable to list posts." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;

  const thread = await getThread(threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { body, tokenId, address, signature, issuedAt, batchTokenIds } =
    (payload ?? {}) as Record<string, unknown>;

  if (
    typeof body !== "string" ||
    !body.trim() ||
    typeof tokenId !== "string" ||
    typeof address !== "string" ||
    typeof signature !== "string" ||
    typeof issuedAt !== "string"
  ) {
    return NextResponse.json(
      { error: "Missing or invalid fields." },
      { status: 400 },
    );
  }

  if (body.length > MAX_BODY_LEN) {
    return NextResponse.json(
      { error: `Body must be ${MAX_BODY_LEN} characters or fewer.` },
      { status: 400 },
    );
  }

  const rate = checkWriteRateLimit(request, address, tokenId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const verification = await verifyPersonaClaim({
    tokenId,
    address,
    signature,
    issuedAt,
    batchTokenIds: Array.isArray(batchTokenIds) ? batchTokenIds : undefined,
  });
  if (!verification.ok) {
    return NextResponse.json(
      {
        error: verification.reason ?? "Not authorized.",
        code: verification.code,
      },
      { status: 403 },
    );
  }

  // See app/api/threads/route.ts for why this happens right after a
  // successful verifyPersonaClaim.
  await markTokenClaimed(tokenId, address);

  const post = await addReply(threadId, tokenId, body.trim());

  // A human just posted into this thread - give it exactly one more AI
  // reply rather than staying silent, same reasoning as
  // app/api/threads/route.ts. Separately, if this reply (plus the thread
  // so far) clears lib/threadQuality.ts's bar, also schedule a staggered
  // reward batch - same mechanic as new threads, extended to replies since
  // an ongoing back-and-forth can be just as funny as an opening post.
  // after() defers all of this past the response, so it never adds
  // Venice-call latency to the human's own reply.
  after(async () => {
    // listPosts already includes this reply - addReply's writePost/RPUSH
    // already landed before this after() callback runs.
    const [, allPosts] = await Promise.all([
      triggerAiReply(thread),
      listPosts(threadId),
    ]);
    const quality = await scoreThreadQuality(thread.subject, allPosts);
    if (quality.passed && (await claimRewardSlot(threadId))) {
      await scheduleStaggeredReplies(
        threadId,
        REWARD_REPLY_COUNT,
        REWARD_WINDOW_MS,
      );
    }
  });

  return NextResponse.json({ post }, { status: 201 });
}
