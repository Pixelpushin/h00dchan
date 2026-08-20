// Public ad-rental submission endpoint. POST validates the OpenSea
// collection (lib/opensea.ts) and the on-chain payment (lib/adPayment.ts)
// before queuing the submission for manual review - nothing here trusts
// client-supplied "I paid" claims on their own. GET returns the currently
// active (paid + approved + not-yet-expired) ads for AdBanner to render.
import { NextRequest, NextResponse } from "next/server";
import { ADDRESS_PATTERN } from "@/lib/address";
import { fetchOpenSeaCollection } from "@/lib/opensea";
import { verifyAdPayment } from "@/lib/adPayment";
import {
  createAdSubmission,
  isTxHashUsed,
  listActiveAds,
  markTxHashUsed,
} from "@/lib/adStore";
import { findAdPrice } from "@/lib/adConfig";
import { checkSignalsRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ads = await listActiveAds();
  return NextResponse.json({
    ads: ads.map((ad) => ({
      id: ad.id,
      name: ad.name,
      imageUrl: ad.imageUrl,
      avatarUrl: ad.avatarUrl || ad.imageUrl,
      openseaUrl: ad.openseaUrl,
    })),
  });
}

export async function POST(request: NextRequest) {
  const rate = checkSignalsRateLimit(request);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { openseaUrl, txHash, tokenSymbol, submitterAddress } = (payload ??
    {}) as Record<string, unknown>;

  if (
    typeof openseaUrl !== "string" ||
    typeof txHash !== "string" ||
    typeof tokenSymbol !== "string" ||
    typeof submitterAddress !== "string"
  ) {
    return NextResponse.json(
      { error: "Missing or invalid fields." },
      { status: 400 },
    );
  }
  if (!ADDRESS_PATTERN.test(submitterAddress)) {
    return NextResponse.json(
      { error: "Invalid submitter address." },
      { status: 400 },
    );
  }
  if (!findAdPrice(tokenSymbol)) {
    return NextResponse.json(
      { error: `${tokenSymbol} is not an accepted token.` },
      { status: 400 },
    );
  }

  // Cheap pre-check only, for UX (fail fast before the RPC/OpenSea calls
  // below) - NOT the correctness gate against a double-spend race, since a
  // SMEMBERS check-then-later-SADD leaves a window where two concurrent
  // requests can both pass it for the same txHash.
  if (await isTxHashUsed(txHash)) {
    return NextResponse.json(
      { error: "That transaction has already been used for a submission." },
      { status: 409 },
    );
  }

  const collectionResult = await fetchOpenSeaCollection(openseaUrl);
  if (!collectionResult.ok) {
    return NextResponse.json(
      { error: collectionResult.reason },
      { status: 400 },
    );
  }

  const paymentResult = await verifyAdPayment(
    txHash,
    tokenSymbol,
    submitterAddress,
  );
  if (!paymentResult.ok) {
    return NextResponse.json({ error: paymentResult.reason }, { status: 402 });
  }

  // The actual gate: verifyAdPayment above is read-only/idempotent, so it's
  // safe to run before this. Claiming the txHash via the atomic SADD is the
  // last check before anything is persisted - only one concurrent request
  // for a given txHash can ever get `true` here, so only one ad can ever be
  // created for it.
  if (!(await markTxHashUsed(txHash))) {
    return NextResponse.json(
      { error: "That transaction has already been used for a submission." },
      { status: 409 },
    );
  }

  const ad = await createAdSubmission({
    openseaUrl: collectionResult.collection.openseaUrl,
    name: collectionResult.collection.name,
    imageUrl: collectionResult.collection.imageUrl,
    avatarUrl: collectionResult.collection.avatarUrl,
    submitterAddress,
    tokenSymbol,
    txHash,
  });

  return NextResponse.json({ ad }, { status: 201 });
}
