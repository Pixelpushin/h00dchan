import { NextRequest, NextResponse } from "next/server";
import { verifyBioVerifyAuth } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { startBioVerification } from "@/lib/bioVerifyStore";
import {
  phraseFromSeed,
  sentenceFromSeed,
  PHRASE_SPACE_SIZE,
} from "@/lib/bioVerifyPhrase";
import { randomInt } from "crypto";

// Starts an X bio verification attempt - proves wallet ownership the same
// way claiming/posting does (personal_sign, see lib/auth-server.ts's
// verifyBioVerifyAuth), then issues a random, funny, on-brand challenge
// phrase (lib/bioVerifyPhrase.ts) the holder posts to their bio+a tweet.
// The phrase itself carries the security property (unpredictable, unique
// per claim, only ever handed out after ownership is confirmed) - it just
// doesn't read like a security token, which is the whole point.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const X_HANDLE_PATTERN = /^@?[A-Za-z0-9_]{1,15}$/;

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const tokenId = typeof body?.tokenId === "string" ? body.tokenId : undefined;
  const address = typeof body?.address === "string" ? body.address : undefined;
  const signature =
    typeof body?.signature === "string" ? body.signature : undefined;
  const issuedAt =
    typeof body?.issuedAt === "string" ? body.issuedAt : undefined;
  const xHandle =
    typeof body?.xHandle === "string" ? body.xHandle.trim() : undefined;

  if (!xHandle || !X_HANDLE_PATTERN.test(xHandle)) {
    return NextResponse.json({ error: "Invalid X handle." }, { status: 400 });
  }
  if (!tokenId || !address) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const limit = checkWriteRateLimit(request, address, tokenId);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts, slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  const auth = await verifyBioVerifyAuth({
    tokenId,
    address,
    signature,
    issuedAt,
  });
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason, code: auth.code },
      { status: 401 },
    );
  }

  // randomInt(max) is exclusive of max, so this covers the full
  // PHRASE_SPACE_SIZE - phraseFromSeed's mixed-radix decomposition means
  // every seed in range maps to exactly one specific phrase.
  const seed = randomInt(PHRASE_SPACE_SIZE);
  const phrase = phraseFromSeed(seed);
  const checkText = sentenceFromSeed(seed);

  const record = await startBioVerification(
    tokenId,
    address,
    xHandle,
    phrase,
    checkText,
  );
  return NextResponse.json({
    phrase: record.phrase,
    xHandle: record.xHandle,
    issuedAt: record.issuedAt,
  });
}
