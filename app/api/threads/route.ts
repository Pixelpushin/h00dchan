import { NextRequest, NextResponse, after } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import {
  checkWriteIpRateLimit,
  consumeVerifiedWriteBudget,
} from "@/lib/rate-limit";
import { createThread, listThreads, markTokenClaimed } from "@/lib/store";
import { triggerAiThread } from "@/lib/aiEngagement";
import { triggerAlphaBotThreadReplies } from "@/lib/alphaBotEngagement";
import {
  claimRewardSlot,
  REWARD_REPLY_COUNT,
  REWARD_WINDOW_MS,
  scheduleStaggeredReplies,
} from "@/lib/scheduledReplies";
import { scoreThreadQuality } from "@/lib/threadQuality";

// Node runtime (not edge) - needed for ethers' verifyMessage in
// lib/auth-server.ts, same reasoning as app/api/token/[tokenId]/route.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUBJECT_LEN = 100;
const MAX_BODY_LEN = 4000;

export async function GET() {
  try {
    const threads = await listThreads();
    // Most-recently-bumped first, same convention as any imageboard board
    // index.
    const payload = [...threads].sort(
      (a, b) => Date.parse(b.bumpedAt) - Date.parse(a.bumpedAt),
    );
    return NextResponse.json({ threads: payload });
  } catch (error) {
    console.error("Failed to list threads", error);
    return NextResponse.json(
      { error: "Unable to list threads." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const {
    subject,
    body,
    tokenId,
    address,
    signature,
    issuedAt,
    batchTokenIds,
  } = (payload ?? {}) as Record<string, unknown>;

  if (
    typeof subject !== "string" ||
    !subject.trim() ||
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

  if (subject.length > MAX_SUBJECT_LEN) {
    return NextResponse.json(
      { error: `Subject must be ${MAX_SUBJECT_LEN} characters or fewer.` },
      { status: 400 },
    );
  }
  if (body.length > MAX_BODY_LEN) {
    return NextResponse.json(
      { error: `Body must be ${MAX_BODY_LEN} characters or fewer.` },
      { status: 400 },
    );
  }

  // Layer 1 (pre-verify): cheapest-possible rejection before the crypto/RPC
  // work in verifyPersonaClaim - see lib/rate-limit.ts for why this matters
  // even for requests carrying a well-formed signature. IP-only on purpose:
  // address/tokenId here are still unverified, client-supplied values, so
  // keying budget on them at this point would let anyone burn a victim's
  // budget just by naming the victim's address in the request body - no
  // signature required. IP is the only dimension available this early that
  // isn't spoofable by the request body itself.
  const ipRate = checkWriteIpRateLimit(request);
  if (!ipRate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(ipRate.retryAfterSeconds) },
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

  // Layer 2 (post-verify): only reached once verifyPersonaClaim has
  // confirmed `address` really signed this claim AND currently owns
  // `tokenId` on-chain, so it's now safe to spend this identity's own
  // budget - nobody but the real holder can ever reach this line for their
  // address/token. Checked AFTER verification (not before, like the IP
  // layer) specifically so an unverified requester can never drain a
  // victim's address/token budget.
  const identityRate = consumeVerifiedWriteBudget(address, tokenId);
  if (!identityRate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(identityRate.retryAfterSeconds) },
      },
    );
  }

  // Marks this tokenId as claimed by this address - a real human just
  // proved ownership and posted, so AI posting for this token turns off
  // (see lib/store.ts's isTokenClaimed) until/unless the token changes
  // hands to a new owner who hasn't claimed it yet.
  await markTokenClaimed(tokenId, address);

  const { thread, post } = await createThread(
    subject.trim(),
    tokenId,
    body.trim(),
  );

  // Every human-created thread triggers exactly one new AI thread
  // elsewhere on the board (one-for-one, not a batch - cheaper, and the
  // board no longer generates content on its own timer), immediately.
  // Separately, THIS thread only gets the staggered-reward extra replies
  // if it clears lib/threadQuality.ts's bar - the reward is meant for
  // genuinely witty/funny posts, not every post, or it's just a second
  // blind bot-spam mechanic. after() runs this once the response has
  // already been sent, so none of it adds Venice-call or Redis latency to
  // the human's own post. triggerAiThread swallows its own errors
  // internally (lib/aiEngagement.ts) - a Venice hiccup here can never
  // break the human's post, which has already succeeded by this point.
  after(async () => {
    const [quality] = await Promise.all([
      scoreThreadQuality(thread.subject, [post]),
      triggerAiThread(),
      // Own try/catch internally (lib/alphaBotEngagement.ts) - qualifies()
      // no-ops for anyone under the hold-duration bar or once today's
      // site-wide budget is spent, so this is a cheap no-op far more often
      // than it's a real Nansen+Venice spend.
      triggerAlphaBotThreadReplies(thread, tokenId),
    ]);
    if (quality.passed && (await claimRewardSlot(thread.id))) {
      await scheduleStaggeredReplies(
        thread.id,
        REWARD_REPLY_COUNT,
        REWARD_WINDOW_MS,
      );
    }
  });

  return NextResponse.json({ thread, post }, { status: 201 });
}
