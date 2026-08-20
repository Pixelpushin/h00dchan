import { NextRequest } from "next/server";
import { ADDRESS_PATTERN } from "@/lib/address";
import { fetchWalletTokensOnChain } from "@/lib/chain";
import { getCollectionSnapshot } from "@/lib/collectionSnapshot";
import { checkPublicApiRateLimit } from "@/lib/rate-limit";
import {
  jsonWithCors,
  rateLimitResponse,
  corsPreflightResponse,
} from "@/lib/publicApi";

// Public dev API - which HOODCHAN tokens a given address currently holds.
// The natural complement to /api/v1/token/{tokenId} for anyone building a
// wallet-connect integration ("what does this visitor's wallet hold").
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const limit = checkPublicApiRateLimit(request);
  if (!limit.allowed) return rateLimitResponse(limit);

  const { address } = await params;
  if (!ADDRESS_PATTERN.test(address)) {
    return jsonWithCors({ error: "Invalid address." }, { status: 400 });
  }

  try {
    // Same fix as /api/wallet-tokens: ownership comes from
    // lib/collectionSnapshot.ts's already-cached whole-collection snapshot
    // instead of this route redoing its own live eth_getLogs walk on every
    // public request - up to 5 minutes stale (same tradeoff every other
    // snapshot-backed metric in this app already accepts), but no longer
    // dependent on Robinhood Chain's RPC staying healthy for every single
    // call. Falls back to the live scan only if the snapshot is down.
    const snapshot = await getCollectionSnapshot().catch(() => null);
    const tokenIds = snapshot
      ? (snapshot.tokensByOwner.get(address.toLowerCase()) ?? [])
      : await fetchWalletTokensOnChain(address);
    return jsonWithCors({ address, count: tokenIds.length, tokenIds });
  } catch {
    return jsonWithCors(
      { error: "Unable to resolve wallet holdings right now." },
      { status: 502 },
    );
  }
}
