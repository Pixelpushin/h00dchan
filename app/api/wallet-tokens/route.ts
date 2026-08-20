// Server-side consolidation of "which HOODCHAN tokens does this address
// own, and what's each one's token-bound wallet status." Originally did
// this by calling three functions (fetchWalletTokensOnChain,
// computeTbaAddress, isTbaActivated) directly from the browser, then moved
// server-to-server to dodge Robinhood Chain's RPC returning a malformed
// CORS header under load; ownership itself was still a live, unbounded
// eth_getLogs walk on every single request even after that move, which
// was slow, and was the entire reason this route needed a strict per-IP
// rate limit in the first place.
//
// Ownership now comes from lib/collectionSnapshot.ts's already-cached,
// whole-collection snapshot instead (see below) - it already has "current
// owner per token" for free, computed once and shared by every caller
// (leaderboard, XP, this route), so there was never a reason to make this
// route recompute the same answer for one address via its own live scan.
// What's LEFT genuinely needing a live RPC call, per owned token, is each
// one's token-bound wallet address (computeTbaAddress - a real eth_call to
// the registry, not pure local math, confirmed by reading @pixelpushin/
// tba-kit's own source rather than assuming) and its activation status
// (isTbaActivated) - that's the one remaining real cost here, chunked
// below the same way it always was.
import { NextRequest, NextResponse } from "next/server";
import { ADDRESS_PATTERN } from "@/lib/address";
import { checkExpensiveScanRateLimit } from "@/lib/rate-limit";
import { fetchWalletTokensOnChain, readBalanceOf } from "@/lib/chain";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import {
  countHumanPostsByToken,
  countHumanThreadsByToken,
  isTokenClaimed,
} from "@/lib/store";
import { computeLevelProgress } from "@/lib/leveling";
import { getBioVerification } from "@/lib/bioVerifyStore";
import { TRUSTED_TOKENS } from "@/lib/trustedTokens";
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

export async function GET(request: NextRequest) {
  // This is the most expensive route in the app (dozens-to-hundreds of RPC
  // calls per request, maxDuration=60) and `address` is an unauthenticated
  // query param anyone can set to anything - keying a limit on it alone
  // would let an attacker just rotate the address param forever, so this
  // has to be IP-keyed. Own tighter budget (checkExpensiveScanRateLimit,
  // 10/5min), not the general public-API one - 120/5min is sized for cheap
  // reads, not a route that fires dozens-to-hundreds of live RPC calls per
  // hit.
  const rate = checkExpensiveScanRateLimit(request);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  try {
    const snapshot = await getCollectionSnapshot().catch(() => null);
    // The collection snapshot already has "current owner per token" for
    // the WHOLE collection, built from one shared, 5-minute-cached scan -
    // this used to redundantly re-derive the same answer for just this one
    // address via its own live, unbounded eth_getLogs walk
    // (fetchWalletTokensOnChain) on every single request, which was both
    // the actual reason this route needed a strict rate limit AND the
    // reason a large wallet's page load was slow enough to look broken.
    // Same up-to-5-minutes staleness every other snapshot-backed metric in
    // this app already accepts (weeksHeld, isTopHolder, nestedHoldingCount
    // below) - a token that changed hands moments ago just isn't reflected
    // here until the next background refresh, same tradeoff, not a new one.
    // Falls back to the live scan only if the snapshot itself is
    // unavailable (e.g. ALCHEMY_API_KEY missing), so this degrades instead
    // of returning nothing.
    const tokenIds = snapshot
      ? (snapshot.tokensByOwner.get(address.toLowerCase()) ?? [])
      : await fetchWalletTokensOnChain(address);

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
    // Reuses the same live, on-chain-ownership-reverified isTokenClaimed()
    // check this loop already runs per token for the level calc, instead
    // of a caller needing a second independent lookup (previously
    // WalletHeaderWidget cross-checked against /api/persona/mine, a Redis
    // reverse index that trusts its stored record's address rather than
    // re-confirming current on-chain ownership - two independently
    // computed "claimed" signals that could legitimately disagree and got
    // reported live as the header staying stuck on "Activate NFTs" even
    // once the collection page - which already uses this same
    // isTokenClaimed check - showed everything activated).
    const claimedTokenIds: string[] = [];
    // Same nestedHoldingCount lookup the level calc below already runs per
    // token (a free O(1) lookup against the shared cached snapshot, no
    // extra RPC) - exposed here too so callers (the collection page) can
    // show/sort on it directly instead of only seeing it baked into an
    // opaque level number. Zero-count tokens are omitted rather than
    // written as 0, keeping this payload small for the common case.
    const nestedCounts: Record<string, number> = {};
    // Which whitelisted ERC-20s (lib/trustedTokens.ts - hand-maintained,
    // never auto-discovered, so a spam-airdropped token can never show up
    // here) each anon's own TBA holds a nonzero balance of. Same "float
    // notable holdings to the top" idea as nestedCounts above, just for
    // tokens instead of nested NFTs - one balanceOf() eth_call per
    // whitelisted token per owned anon, chunked in the same batch as
    // everything else in this loop rather than a separate pass.
    const trustedTokenHoldings: Record<string, string[]> = {};
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
                trustedBalances,
              ] = await Promise.all([
                isTbaActivated(tbaAddress),
                isTokenClaimed(tokenId).catch(() => false),
                countHumanPostsByToken(tokenId).catch(() => 0),
                countHumanThreadsByToken(tokenId).catch(() => 0),
                getBioVerification(tokenId).catch(() => null),
                Promise.all(
                  TRUSTED_TOKENS.map((t) =>
                    readBalanceOf(t.address, tbaAddress).catch(() => BigInt(0)),
                  ),
                ),
              ]);
              const heldSymbols = TRUSTED_TOKENS.filter(
                (_, i) => trustedBalances[i] > BigInt(0),
              ).map((t) => t.symbol);
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
              const nested = snapshot
                ? nestedHoldingCount(snapshot, tbaAddress)
                : 0;
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
                nestedHoldingCount: nested,
                bioVerified: bioVerification?.status === "verified",
              }).level;
              return [
                tokenId,
                { address: tbaAddress, activated },
                level,
                claimed,
                nested,
                heldSymbols,
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
          if (entry[3]) claimedTokenIds.push(entry[0]);
          if (entry[4] > 0) nestedCounts[entry[0]] = entry[4];
          if (entry[5].length > 0) trustedTokenHoldings[entry[0]] = entry[5];
        }
      }
    }

    return NextResponse.json({
      tokenIds,
      wallets,
      levels,
      claimedTokenIds,
      nestedCounts,
      trustedTokenHoldings,
    });
  } catch (error) {
    console.error(`Failed to load wallet tokens for ${address}`, error);
    return NextResponse.json(
      { error: "Unable to load tokens from chain right now." },
      { status: 502 },
    );
  }
}
