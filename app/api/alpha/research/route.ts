// Owner-triggered Alpha Bot research. Gated exactly like /api/claim - the
// same personal_sign proof-of-ownership claim already used to silence a
// clanker is reused here as general proof-of-ownership, not a new signing
// flow. No cron, no public trigger: every call here spends real Nansen
// credits (and a Venice call), so only the anon's actual current owner can
// fire it. Shares its eligibility/budget/TBA-resolution logic with lib/
// alphaBotEngagement.ts (the auto-reply-on-post path) rather than
// maintaining a second copy that could quietly drift out of agreement with
// it - both should always answer "does this anon qualify" identically.
import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { MAX_ALPHA_BOT_EVENTS_PER_DAY } from "@/lib/alphaBotConfig";
import {
  consumeDailyAlphaBotBudget,
  getAlphaBotEntry,
} from "@/lib/alphaBotStore";
import {
  alphaBotQualifies,
  getOrRefreshAlphaBotEntry,
  resolveTbaAddress,
} from "@/lib/alphaBotEngagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESEARCH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { tokenId, address, signature, issuedAt } = (payload ?? {}) as Record<
    string,
    unknown
  >;

  if (
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

  let tbaAddress: string;
  try {
    tbaAddress = await resolveTbaAddress(tokenId);
  } catch (error) {
    console.error(`Alpha Bot TBA lookup failed for #${tokenId}`, error);
    return NextResponse.json(
      { error: "Unable to resolve this anon's wallet - try again shortly." },
      { status: 500 },
    );
  }

  if (!(await alphaBotQualifies(tokenId, tbaAddress))) {
    return NextResponse.json(
      {
        error:
          "Alpha Bot is reserved for anons held since the launch snapshot, or that have another HOODCHAN nested in their own token-bound wallet.",
        code: "NOT_ELIGIBLE",
      },
      { status: 403 },
    );
  }

  const existing = await getAlphaBotEntry(tokenId);
  if (
    existing &&
    Date.now() - Date.parse(existing.generatedAt) < RESEARCH_COOLDOWN_MS
  ) {
    return NextResponse.json({ entry: existing, cached: true });
  }

  if (!(await consumeDailyAlphaBotBudget(MAX_ALPHA_BOT_EVENTS_PER_DAY))) {
    return NextResponse.json(
      {
        error:
          "Alpha Bot has hit its site-wide daily research budget - try again tomorrow.",
        code: "DAILY_BUDGET_EXHAUSTED",
      },
      { status: 429 },
    );
  }

  try {
    const entry = await getOrRefreshAlphaBotEntry(tokenId, tbaAddress);
    return NextResponse.json({ entry, cached: false });
  } catch (error) {
    console.error(`Alpha Bot research failed for #${tokenId}`, error);
    return NextResponse.json(
      { error: "Research failed - try again shortly." },
      { status: 500 },
    );
  }
}
