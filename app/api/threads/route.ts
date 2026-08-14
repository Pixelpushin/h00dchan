import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { createThread, listThreads, markTokenClaimed } from "@/lib/store";

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

  const { subject, body, tokenId, address, signature, issuedAt } = (payload ??
    {}) as Record<string, unknown>;

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

  // Cheapest-possible rejection before the crypto/RPC work in
  // verifyPersonaClaim - see lib/rate-limit.ts for why this matters even
  // for requests carrying a well-formed signature.
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
  return NextResponse.json({ thread, post }, { status: 201 });
}
