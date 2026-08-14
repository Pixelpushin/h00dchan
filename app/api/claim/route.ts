// Actually silences a clanker at sign time - previously the only place
// markTokenClaimed() was ever called was inside the thread/reply POST
// routes, so signing the claim message on the home page did nothing
// server-side by itself: the AI kept posting until you separately started
// a thread or reply. That contradicts the site's own advertised promise
// ("sign - and that anon's AI dies on the spot," see WhatIsHoodchan.tsx)
// and meant the "clankers silenced" counter never moved on activation.
// This route closes that gap: same verify-then-mark pattern as
// app/api/threads/route.ts, just without also creating a post.
import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { isTokenClaimed, markTokenClaimed } from "@/lib/store";
import { isValidTokenId } from "@/lib/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  await markTokenClaimed(tokenId, address);
  return NextResponse.json({ ok: true });
}

// Public, read-only - lets the token grid show each owned token's real
// claimed status (not just "is this the one I'm currently posting as",
// which is a separate, single-slot concept - see lib/usePersona.ts).
export async function GET(request: NextRequest) {
  const tokenId = request.nextUrl.searchParams.get("tokenId");
  if (!tokenId || !isValidTokenId(tokenId)) {
    return NextResponse.json({ error: "Invalid token ID." }, { status: 400 });
  }
  const claimed = await isTokenClaimed(tokenId);
  return NextResponse.json({ tokenId, claimed });
}
