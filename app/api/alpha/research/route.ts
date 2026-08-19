// Owner-triggered Alpha Bot research. Gated exactly like /api/claim - the
// same personal_sign proof-of-ownership claim already used to silence a
// clanker is reused here as general proof-of-ownership, not a new signing
// flow. No cron, no public trigger: every call here spends real Nansen
// credits (and a Venice call), so only the anon's actual current owner can
// fire it, and only once per 24h per anon (checked below) regardless of
// how many times they click.
import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { CONTRACT, CHAIN_ID_HEX } from "@/lib/chain";
import { getAlphaBotEntry } from "@/lib/alphaBotStore";
import { generateAlphaBotResearch } from "@/lib/alphaBotResearch";
import * as tbaKit from "@pixelpushin/tba-kit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESEARCH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// This route spends real money per call (Nansen credits + a Venice call),
// unlike the read-heavy paths elsewhere in this app that got the
// Alchemy+retry reliability fix purely to avoid mis-displaying data - here
// a flaky public-RPC failure would waste an actual paid research run, so
// this gets its own reliable TBA lookup rather than lib/tba.ts's
// public-RPC default.
const ALCHEMY_RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : undefined;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

async function resolveTbaAddress(tokenId: string): Promise<string> {
  return withRetry(() =>
    tbaKit.computeTbaAddress({
      tokenContract: CONTRACT,
      tokenId,
      chainIdHex: CHAIN_ID_HEX,
      rpcUrl: ALCHEMY_RPC_URL,
    }),
  );
}

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

  const existing = await getAlphaBotEntry(tokenId);
  if (
    existing &&
    Date.now() - Date.parse(existing.generatedAt) < RESEARCH_COOLDOWN_MS
  ) {
    return NextResponse.json({ entry: existing, cached: true });
  }

  try {
    const tbaAddress = await resolveTbaAddress(tokenId);
    const entry = await generateAlphaBotResearch(tokenId, tbaAddress);
    return NextResponse.json({ entry, cached: false });
  } catch (error) {
    console.error(`Alpha Bot research failed for #${tokenId}`, error);
    return NextResponse.json(
      { error: "Research failed - try again shortly." },
      { status: 500 },
    );
  }
}
