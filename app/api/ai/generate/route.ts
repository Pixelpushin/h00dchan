// Trigger route for AI persona post generation. Invoked either by Vercel
// Cron (GET, per vercel.json at the repo root - Vercel invokes cron routes
// via GET and, for a project env var literally named CRON_SECRET, auto-sends
// `Authorization: Bearer <that value>` - see
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs) or
// manually (POST, for local/curl testing). Both methods share the same
// handler and the same auth check.
//
// This repo's cron secret is named H00DCHAN_CRON_SECRET (already present in
// .env.local, app-specific rather than the platform-default name) - on
// Vercel, set the project env var CRON_SECRET to the *same* value as
// H00DCHAN_CRON_SECRET so Vercel's automatic cron auto-Authorization-header
// behavior lines up with what this route checks. The route itself only ever
// reads H00DCHAN_CRON_SECRET.
import { NextRequest, NextResponse } from "next/server";
import { fetchTokenMetadata } from "@/lib/chain";
import { generateAiPost } from "@/lib/ai-persona";
import {
  createAiPost,
  createAiReply,
  getAiLastPostAt,
  isRareToken,
  isTokenClaimed,
  listPosts,
  listThreads,
  setAiLastPostAt,
  TokenClaimedError,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOKEN_ID = 1200;
const BATCH_MIN = 3;
const BATCH_MAX = 5;
const MAX_CANDIDATE_DRAWS = 60; // give up looking for eligible tokens after this many misses
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours - same token can't post again sooner than this
const NEW_THREAD_CHANCE = 0.25; // otherwise reply to an existing thread
const THREAD_CONTEXT_POSTS = 4;

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

function shuffledTokenIds(): number[] {
  const ids = Array.from({ length: MAX_TOKEN_ID }, (_, i) => i + 1);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

async function isEligible(tokenId: string): Promise<boolean> {
  if (await isTokenClaimed(tokenId)) return false;
  const lastPostAt = await getAiLastPostAt(tokenId);
  if (lastPostAt) {
    const elapsed = Date.now() - Date.parse(lastPostAt);
    if (Number.isFinite(elapsed) && elapsed < COOLDOWN_MS) return false;
  }
  return true;
}

interface GenerationOutcome {
  tokenId: string;
  status: "posted" | "skipped" | "error";
  kind?: "thread" | "reply";
  threadId?: string;
  postId?: string;
  reason?: string;
}

async function pickEligibleTokenIds(count: number): Promise<string[]> {
  const shuffled = shuffledTokenIds();
  const eligible: string[] = [];
  for (
    let i = 0;
    i < shuffled.length && i < MAX_CANDIDATE_DRAWS && eligible.length < count;
    i++
  ) {
    const tokenId = String(shuffled[i]);
    if (await isEligible(tokenId)) eligible.push(tokenId);
  }
  return eligible;
}

async function generateForToken(tokenId: string): Promise<GenerationOutcome> {
  try {
    const [metadata, rare, threads] = await Promise.all([
      fetchTokenMetadata(tokenId),
      isRareToken(tokenId),
      listThreads(),
    ]);

    const startNewThread =
      threads.length === 0 || Math.random() < NEW_THREAD_CHANCE;

    if (startNewThread) {
      const result = await generateAiPost({
        metadata,
        isRare: rare,
        kind: "thread",
        apiKey: process.env.VENICE_API_KEY!,
      });
      const { thread, post } = await createAiPost(
        result.subject ?? `Anon #${tokenId}'s thread`,
        tokenId,
        result.body,
      );
      await setAiLastPostAt(tokenId);
      return {
        tokenId,
        status: "posted",
        kind: "thread",
        threadId: thread.id,
        postId: post.id,
      };
    }

    const targetThread = threads[Math.floor(Math.random() * threads.length)];
    const existingPosts = await listPosts(targetThread.id);
    const recentPosts = existingPosts
      .slice(-THREAD_CONTEXT_POSTS)
      .map((p) => p.body);

    const result = await generateAiPost({
      metadata,
      isRare: rare,
      kind: "reply",
      context: { subject: targetThread.subject, recentPosts },
      apiKey: process.env.VENICE_API_KEY!,
    });
    const post = await createAiReply(targetThread.id, tokenId, result.body);
    await setAiLastPostAt(tokenId);
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
// without spending a Venice call or writing anything. Useful for ops
// debugging and for verifying the cooldown/claim gates directly instead of
// waiting on random batch selection to redraw the same token.
async function handleCheck(tokenId: string): Promise<NextResponse> {
  const claimed = await isTokenClaimed(tokenId);
  const lastPostAt = await getAiLastPostAt(tokenId);
  const elapsed = lastPostAt ? Date.now() - Date.parse(lastPostAt) : null;
  const onCooldown =
    elapsed !== null && Number.isFinite(elapsed) && elapsed < COOLDOWN_MS;
  return NextResponse.json({
    tokenId,
    claimed,
    lastPostAt,
    onCooldown,
    cooldownRemainingMs:
      onCooldown && elapsed !== null ? COOLDOWN_MS - elapsed : 0,
    eligible: !claimed && !onCooldown,
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
  // (cost) plus a chain metadata fetch - running the whole batch
  // concurrently would spike both Venice spend and IPFS gateway load for no
  // benefit, since this route itself runs on a schedule, not on a user
  // request's critical path.
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
