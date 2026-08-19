import { NextRequest } from "next/server";
import {
  getOrFetchTokenMetadata,
  isTokenClaimed,
  countHumanPostsByToken,
  countHumanThreadsByToken,
} from "@/lib/store";
import { isValidTokenId } from "@/lib/persona";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import { computeLevelProgress } from "@/lib/leveling";
import { getBioVerification } from "@/lib/bioVerifyStore";
import {
  getCollectionSnapshot,
  weeksHeld,
  extraCollectionTokens,
  isTopHolder,
  nestedHoldingCount,
} from "@/lib/collectionSnapshot";
import { checkPublicApiRateLimit } from "@/lib/rate-limit";
import {
  jsonWithCors,
  rateLimitResponse,
  corsPreflightResponse,
} from "@/lib/publicApi";

// Public dev API - one anon's full public state: metadata (name, image -
// a permanent Blob URL once app/api/admin/backfill-images has run for
// this token, otherwise a live IPFS gateway URL), wallet info, and level/
// XP. See /developers for docs and openapi.json for the full spec.
//
// Deliberately does NOT expose anything private: no addresses beyond the
// token-bound wallet address itself (which is public on-chain data
// anyway, derivable by anyone from the tokenId), no admin data, no raw
// signatures.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const limit = checkPublicApiRateLimit(request);
  if (!limit.allowed) return rateLimitResponse(limit);

  const { tokenId } = await params;
  if (!isValidTokenId(tokenId)) {
    return jsonWithCors({ error: "Invalid token ID." }, { status: 400 });
  }

  let metadata;
  try {
    metadata = await getOrFetchTokenMetadata(tokenId);
  } catch {
    return jsonWithCors(
      { error: "Unable to resolve token metadata." },
      { status: 502 },
    );
  }

  let tbaAddress: string | null = null;
  let walletActivated = false;
  try {
    tbaAddress = await computeTbaAddress(tokenId);
    walletActivated = await isTbaActivated(tbaAddress);
  } catch {
    // Wallet info degrades to null/false rather than failing the whole
    // response - metadata is the part most integrations actually need.
  }

  const [claimed, humanPosts, humanThreads, snapshot, bioVerification] =
    await Promise.all([
      isTokenClaimed(tokenId).catch(() => false),
      countHumanPostsByToken(tokenId).catch(() => 0),
      countHumanThreadsByToken(tokenId).catch(() => 0),
      getCollectionSnapshot().catch(() => null),
      getBioVerification(tokenId).catch(() => null),
    ]);

  const level = computeLevelProgress({
    claimed,
    walletActivated,
    threadsStarted: humanThreads,
    totalPosts: humanPosts,
    hasSentTransaction: false, // not exposed here - would cost a per-request RPC call for a field most integrations won't use
    hodlerWeeks: snapshot ? weeksHeld(snapshot, tokenId) : 0,
    extraCollectionTokens: snapshot
      ? extraCollectionTokens(snapshot, tokenId)
      : 0,
    isTopHolder: snapshot ? isTopHolder(snapshot, tokenId) : false,
    nestedHoldingCount:
      snapshot && tbaAddress ? nestedHoldingCount(snapshot, tbaAddress) : 0,
    bioVerified: bioVerification?.status === "verified",
  });

  return jsonWithCors({
    tokenId,
    name: metadata.name,
    image: metadata.image,
    attributes: metadata.attributes,
    claimed,
    wallet: tbaAddress
      ? { address: tbaAddress, activated: walletActivated }
      : null,
    level: level.level,
    totalXp: level.totalXp,
    xpBreakdown: level.breakdown,
  });
}
