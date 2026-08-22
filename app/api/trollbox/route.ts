import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import {
  checkWriteIpRateLimit,
  consumeVerifiedWriteBudget,
} from "@/lib/rate-limit";
import { markTokenClaimed } from "@/lib/store";
import { addTrollboxMessage, listTrollboxMessages } from "@/lib/trollboxStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short on purpose - a scrolling live chat line, not a board post. Same
// spirit as X's own length cap, which is the exact platform Brady asked
// about piping in before landing on "build our own" instead.
const MAX_BODY_LEN = 280;

export async function GET() {
  try {
    const messages = await listTrollboxMessages();
    return NextResponse.json({ messages });
  } catch (error) {
    console.error("Failed to list trollbox messages", error);
    return NextResponse.json(
      { error: "Unable to load the trollbox." },
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

  // Same two-layer rate limit as every other signed write route (see
  // app/api/threads/route.ts for the full reasoning) - IP-only before
  // identity is proven, then per-address/token after.
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

  await markTokenClaimed(tokenId, address);

  const message = await addTrollboxMessage(tokenId, body.trim());
  return NextResponse.json({ message }, { status: 201 });
}
