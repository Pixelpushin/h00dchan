// Server-side consolidation of "which HOODCHAN tokens does this address
// own, and what's each one's token-bound wallet status" - this used to be
// three functions (fetchWalletTokensOnChain, computeTbaAddress,
// isTbaActivated) called directly from the browser against Robinhood
// Chain's own RPC. That worked at low request volume (verified live,
// earlier this session), but a holder with a lot of tokens generates
// dozens-to-hundreds of concurrent eth_call requests straight from the
// browser, and at that volume Robinhood's RPC was confirmed live (via a
// real user's browser console) to sometimes return a malformed
// Access-Control-Allow-Origin header ("*,*" instead of "*"), which every
// browser correctly refuses to accept - silently dropping whichever
// requests hit it (fetchWalletTokensOnChain's per-candidate ownership
// checks catch-and-drop failures, so this looked like "some of my tokens
// just don't show up" rather than a visible error). Moving this
// server-to-server sidesteps the browser CORS enforcement entirely - it
// was never a real cross-origin *security* boundary here, just an
// incidental one this RPC's own infra can't reliably satisfy under load.
import { NextRequest, NextResponse } from "next/server";
import { fetchWalletTokensOnChain, readBlockNumber } from "@/lib/chain";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import {
  countHumanPostsByToken,
  countHumanThreadsByToken,
  isTokenClaimed,
} from "@/lib/store";
import { computeLevelProgress } from "@/lib/leveling";
import { getBioVerification } from "@/lib/bioVerifyStore";
import {
  getCollectionSnapshot,
  weeksHeld,
  extraCollectionTokens,
  isTopHolder,
  nestedHoldingCount,
} from "@/lib/collectionSnapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  const fromBlock = request.nextUrl.searchParams.get("fromBlock") ?? undefined;
  const knownTokenIdsParam = request.nextUrl.searchParams.get("knownTokenIds");
  const knownTokenIds = knownTokenIdsParam
    ? knownTokenIdsParam.split(",").filter(Boolean)
    : undefined;

  try {
    const [tokenIds, lastScannedBlock, snapshot] = await Promise.all([
      fetchWalletTokensOnChain(address, { fromBlock, knownTokenIds }),
      readBlockNumber(),
      getCollectionSnapshot().catch(() => null),
    ]);

    // Chunked, not one unbounded Promise.all across every token - a
    // holder with a lot of tokens (2 RPC calls each: account() + getCode())
    // firing all at once turned out to be exactly the kind of burst that
    // makes Robinhood Chain's RPC start rejecting/timing out a random
    // subset, which silently dropped those tokens' wallet info (the
    // symptom: "some of my NFTs show a wallet line, some don't" - not an
    // all-or-nothing failure, a partial one). Same concurrency-chunking
    // convention as fetchWalletTokensOnChain's own ownership checks
    // (lib/chain.ts), plus up to 2 retries per token before giving up,
    // since a single dropped request is more likely transient than a
    // real error. Even so, an occasional token still won't resolve in
    // any given request - HomeClient.tsx's loadTokens merges this
    // response with its previous render cache rather than replacing it,
    // so a transient miss here doesn't regress something the UI already
    // showed successfully.
    const TBA_CONCURRENCY = 8;
    const wallets: Record<string, { address: string; activated: boolean }> = {};
    const levels: Record<string, number> = {};
    for (let i = 0; i < tokenIds.length; i += TBA_CONCURRENCY) {
      const batch = tokenIds.slice(i, i + TBA_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (tokenId) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const tbaAddress = await computeTbaAddress(tokenId);
              const [
                activated,
                claimed,
                humanTotalPosts,
                humanThreadsStarted,
                bioVerification,
              ] = await Promise.all([
                isTbaActivated(tbaAddress),
                isTokenClaimed(tokenId).catch(() => false),
                countHumanPostsByToken(tokenId).catch(() => 0),
                countHumanThreadsByToken(tokenId).catch(() => 0),
                getBioVerification(tokenId).catch(() => null),
              ]);
              // hasSentTransaction is deliberately left false here rather
              // than paying one more eth_getTransactionCount call per
              // token - this route already fires 2+ RPC calls per token
              // for a holder's full wallet list (confirmed live earlier
              // this session as the exact class of endpoint that trips
              // Robinhood Chain's RPC under burst), and that one milestone
              // isn't worth tripling the load here. hodler/collector/top-
              // holder/nested are free (one shared cached snapshot, O(1)
              // lookups), so those stay accurate. The dedicated profile
              // page and leaderboard both compute the real value.
              const level = computeLevelProgress({
                claimed,
                threadsStarted: humanThreadsStarted,
                totalPosts: humanTotalPosts,
                hasSentTransaction: false,
                hodlerWeeks: snapshot ? weeksHeld(snapshot, tokenId) : 0,
                extraCollectionTokens: snapshot
                  ? extraCollectionTokens(snapshot, tokenId)
                  : 0,
                isTopHolder: snapshot ? isTopHolder(snapshot, tokenId) : false,
                nestedHoldingCount: snapshot
                  ? nestedHoldingCount(snapshot, tbaAddress)
                  : 0,
                bioVerified: bioVerification?.status === "verified",
              }).level;
              return [
                tokenId,
                { address: tbaAddress, activated },
                level,
              ] as const;
            } catch {
              // one retry, then give up on this token for this request -
              // the client re-fetches on every page load anyway.
            }
          }
          return null;
        }),
      );
      for (const entry of results) {
        if (entry) {
          wallets[entry[0]] = entry[1];
          levels[entry[0]] = entry[2];
        }
      }
    }

    return NextResponse.json({ tokenIds, lastScannedBlock, wallets, levels });
  } catch (error) {
    console.error(`Failed to load wallet tokens for ${address}`, error);
    return NextResponse.json(
      { error: "Unable to load tokens from chain right now." },
      { status: 502 },
    );
  }
}
