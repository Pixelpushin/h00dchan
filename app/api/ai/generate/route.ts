// Manual/admin batch trigger for AI persona post generation. No longer
// invoked by a cron - the board switched from "posts on a timer regardless
// of activity" to "gets louder when a human actually shows up" once the
// board was seeded and real activations started coming in (see
// lib/aiEngagement.ts's triggerAiReply, called directly from
// app/api/threads/[threadId]/posts/route.ts). This route stays for manual
// seeding/ops use (curl + H00DCHAN_CRON_SECRET), same auth as every other
// admin action in this repo.
//
// Reply-only, same as every other AI trigger in this app (explicit
// instruction: only humans start new threads, bots are reply guys now) -
// this used to also be able to start a brand-new thread itself
// (NEW_THREAD_CHANCE), which is gone now.
import { NextRequest, NextResponse } from "next/server";
import { fetchBurnedTokenIds } from "@/lib/chain";
import {
  generateAiReplyForToken,
  pickEligibleTokenIds,
} from "@/lib/aiEngagement";
import {
  getAiLastPostAt,
  isTokenClaimed,
  listThreads,
  TokenClaimedError,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sequential batch of up to BATCH_MAX generations (each a Venice call plus
// chain/metadata reads) needs real headroom - the platform default is too
// short for a 15-item sequential batch. 300s is comfortably above the
// realistic worst case and still well under Pro plan limits.
export const maxDuration = 300;

const BATCH_MIN = 3;
const BATCH_MAX = 8;
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // kept in sync with lib/aiEngagement.ts's own constant, only used here for the diagnostic ?check= mode

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

interface GenerationOutcome {
  tokenId: string;
  status: "posted" | "skipped" | "error";
  kind?: "reply";
  threadId?: string;
  postId?: string;
  reason?: string;
}

async function generateForToken(tokenId: string): Promise<GenerationOutcome> {
  try {
    const threads = await listThreads();
    if (threads.length === 0) {
      return {
        tokenId,
        status: "skipped",
        reason: "no threads to reply to yet - only humans start new threads",
      };
    }

    const targetThread = threads[Math.floor(Math.random() * threads.length)];
    const post = await generateAiReplyForToken(tokenId, targetThread);
    return {
      tokenId,
      status: "posted",
      kind: "reply",
      threadId: targetThread.id,
      postId: post.id,
    };
  } catch (error) {
    if (error instanceof TokenClaimedError) {
      return { tokenId, status: "skipped", reason: "claimed" };
    }
    console.error(`AI generation failed for token ${tokenId}`, error);
    return {
      tokenId,
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// Auth-gated diagnostic mode - `?check=<tokenId>` reports whether one
// specific token is currently AI-eligible (not claimed, not on cooldown)
// without spending a Venice call or writing anything.
async function handleCheck(tokenId: string): Promise<NextResponse> {
  const [claimed, burnedIds] = await Promise.all([
    isTokenClaimed(tokenId),
    fetchBurnedTokenIds(),
  ]);
  const burned = burnedIds.includes(tokenId);
  const lastPostAt = await getAiLastPostAt(tokenId);
  const elapsed = lastPostAt ? Date.now() - Date.parse(lastPostAt) : null;
  const onCooldown =
    elapsed !== null && Number.isFinite(elapsed) && elapsed < COOLDOWN_MS;
  return NextResponse.json({
    tokenId,
    claimed,
    burned,
    lastPostAt,
    onCooldown,
    cooldownRemainingMs:
      onCooldown && elapsed !== null ? COOLDOWN_MS - elapsed : 0,
    eligible: !burned && !claimed && !onCooldown,
  });
}

async function handleGenerate(request: NextRequest): Promise<NextResponse> {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const checkTokenId = request.nextUrl.searchParams.get("check");
  if (checkTokenId) {
    return handleCheck(checkTokenId);
  }

  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) {
    console.error("AI generation unavailable: VENICE_API_KEY missing");
    return NextResponse.json(
      { error: "AI generation is not configured." },
      { status: 503 },
    );
  }

  const batchSize =
    BATCH_MIN + Math.floor(Math.random() * (BATCH_MAX - BATCH_MIN + 1));
  const candidates = await pickEligibleTokenIds(batchSize);

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      message:
        "No AI-eligible tokens available right now (all claimed or on cooldown).",
      results: [],
    });
  }

  // Sequential, not parallel: each generation is a real Venice API call
  // (cost) plus a chain metadata fetch.
  const results: GenerationOutcome[] = [];
  for (const tokenId of candidates) {
    results.push(await generateForToken(tokenId));
  }

  return NextResponse.json({ ok: true, results });
}

export async function POST(request: NextRequest) {
  return handleGenerate(request);
}

export async function GET(request: NextRequest) {
  return handleGenerate(request);
}
