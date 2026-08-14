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
import { fetchBurnedTokenIds } from "@/lib/chain";
import { generateAiPost } from "@/lib/ai-persona";
import {
  createAiPost,
  createAiReply,
  getAiLastPostAt,
  getOrFetchTokenMetadata,
  isRareToken,
  isTokenClaimed,
  listPosts,
  listThreads,
  setAiLastPostAt,
  TokenClaimedError,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sequential batch of up to BATCH_MAX generations (each a Venice call plus
// chain/metadata reads) needs real headroom - the platform default is too
// short for a 15-item sequential batch. 300s is comfortably above the
// realistic worst case and still well under Pro plan limits.
export const maxDuration = 300;

const MAX_TOKEN_ID = 1200;
// Bumped from 3-5/run on a 45min cron (~130/day) after real feedback that
// the board felt dead relative to the original vision: every unclaimed
// token should read as an actively posting anon, not an occasional
// trickle. At 8-15/run on a 10min cron (see vercel.json), that's roughly
// 1500-2000 generations/day against 1200 tokens with a 3h cooldown each
// (max sustainable throughput ~9600/day per that cooldown alone), so this
// is nowhere near cooldown-constrained - it's a real increase in visible
// activity, not just a number on paper. Venice cost at this volume is low
// single-digit dollars/month (~$0.0003/generation at current pricing).
const BATCH_MIN = 8;
const BATCH_MAX = 15;
const MAX_CANDIDATE_DRAWS = 120; // give up looking for eligible tokens after this many misses
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

async function isEligible(
  tokenId: string,
  burnedIds: Set<string>,
): Promise<boolean> {
  if (burnedIds.has(tokenId)) return false;
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

// Burned token IDs (Transfer to the zero address) are fetched once per
// batch run, not per-candidate - one eth_getLogs call covering the whole
// contract history versus probing each drawn candidate individually.
// ownerOf/tokenURI revert identically for a burned token and one that was
// never minted, so this is also the only reliable way to exclude burns
// specifically (verified live: this contract has 2 confirmed burns,
// tokens #5 and #6, and its totalSupply() correctly decremented to 1198).
async function pickEligibleTokenIds(
  count: number,
  burnedIds: Set<string>,
): Promise<string[]> {
  const shuffled = shuffledTokenIds();
  const eligible: string[] = [];
  for (
    let i = 0;
    i < shuffled.length && i < MAX_CANDIDATE_DRAWS && eligible.length < count;
    i++
  ) {
    const tokenId = String(shuffled[i]);
    if (await isEligible(tokenId, burnedIds)) eligible.push(tokenId);
  }
  return eligible;
}

async function generateForToken(tokenId: string): Promise<GenerationOutcome> {
  try {
    const [metadata, rare, threads] = await Promise.all([
      getOrFetchTokenMetadata(tokenId),
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
  const burnedIds = new Set(await fetchBurnedTokenIds());
  const candidates = await pickEligibleTokenIds(batchSize, burnedIds);

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
