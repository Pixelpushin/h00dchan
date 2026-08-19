import { NextRequest, NextResponse } from "next/server";
import {
  getBioVerification,
  isPendingExpired,
  markBioVerified,
} from "@/lib/bioVerifyStore";
import { fetchXUserBio } from "@/lib/xApi";
import { checkSignalsRateLimit } from "@/lib/rate-limit";

// Checks whether the phrase issued by /api/bio-verify/start actually shows
// up in the claimed handle's public bio yet - no signature needed here
// (the ownership proof already happened at /start; this step only reads
// public X data). A third party spamming this for a tokenId they don't
// own can't gain anything - it only ever confirms/denies whether the
// phrase THAT token's real owner received is already publicly posted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const limit = checkSignalsRateLimit(request);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts, slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  const body = await request.json().catch(() => null);
  const tokenId = typeof body?.tokenId === "string" ? body.tokenId : undefined;
  if (!tokenId) {
    return NextResponse.json({ error: "Missing tokenId." }, { status: 400 });
  }

  const record = await getBioVerification(tokenId);
  if (!record || record.status !== "pending") {
    return NextResponse.json(
      { error: "No pending verification for this token." },
      { status: 404 },
    );
  }
  if (isPendingExpired(record)) {
    return NextResponse.json(
      { error: "Challenge expired, request a new phrase." },
      { status: 410 },
    );
  }

  let bio;
  try {
    bio = await fetchXUserBio(record.xHandle);
  } catch {
    return NextResponse.json(
      { error: "Unable to check X right now, try again shortly." },
      { status: 502 },
    );
  }
  if (!bio) {
    return NextResponse.json(
      { error: "X account not found." },
      { status: 404 },
    );
  }

  // checkText, not the full displayed phrase - X auto-linkifies a bare
  // domain like "hoodchan.org" into its own t.co link the instant a bio is
  // saved (confirmed live: a real saved bio came back as "...wallet -
  // https://t.co/xxxxx", not the literal site tag text), so matching
  // against the full phrase rejected every real, correctly-completed
  // submission. checkText is just the sentence, with no domain text to
  // get mangled.
  const found = bio.description
    .toLowerCase()
    .includes(record.checkText.toLowerCase());
  if (!found) {
    return NextResponse.json({ verified: false });
  }

  const updated = await markBioVerified(tokenId);
  return NextResponse.json({
    verified: true,
    verifiedAt: updated?.verifiedAt ?? null,
  });
}
