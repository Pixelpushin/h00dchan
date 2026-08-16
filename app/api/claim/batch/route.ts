// Batch version of /api/claim - one signature (see lib/persona.ts's
// buildBatchAuthMessage) authorizes marking several tokens claimed in one
// request, instead of one wallet-signature prompt per token ("Activate
// All" in app/components/HomeClient.tsx). Still no on-chain transaction
// and no gas either way - claiming was always an off-chain personal_sign,
// batching just means building one message instead of N.
import { NextRequest, NextResponse } from "next/server";
import { verifyBatchPersonaClaim } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { markTokenClaimed } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { tokenIds, address, signature, issuedAt } = (payload ?? {}) as Record<
    string,
    unknown
  >;

  if (
    !Array.isArray(tokenIds) ||
    tokenIds.length === 0 ||
    !tokenIds.every((id) => typeof id === "string") ||
    typeof address !== "string" ||
    typeof signature !== "string" ||
    typeof issuedAt !== "string"
  ) {
    return NextResponse.json(
      { error: "Missing or invalid fields." },
      { status: 400 },
    );
  }

  // Keyed on a fixed "batch-claim" token slot rather than any real
  // tokenId - the per-IP and per-address limits are what matter for this
  // action, not a per-token one.
  const rate = checkWriteRateLimit(request, address, "batch-claim");
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const verification = await verifyBatchPersonaClaim({
    tokenIds,
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

  // Writes are independent per token (each touches its own Redis key), so
  // no reason to serialize them either - same reasoning as the ownership
  // checks in verifyBatchPersonaClaim.
  const entries = await Promise.all(
    tokenIds.map(async (tokenId) => {
      const tokenResult = verification.perToken![tokenId];
      if (tokenResult.ok) {
        await markTokenClaimed(tokenId, address);
        return [tokenId, { ok: true }] as const;
      }
      return [tokenId, tokenResult] as const;
    }),
  );
  const results = Object.fromEntries(entries);

  return NextResponse.json({ results });
}
