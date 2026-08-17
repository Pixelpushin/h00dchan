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
import { countPostsByToken, isTokenClaimed, listThreads } from "@/lib/store";
import { computeLevelProgress } from "@/lib/leveling";

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
    const [tokenIds, lastScannedBlock, threads] = await Promise.all([
      fetchWalletTokensOnChain(address, { fromBlock, knownTokenIds }),
      readBlockNumber(),
      // Fetched once for the whole wallet, not per-token - listThreads()
      // is already cache-backed (see lib/store.ts), so this is cheap
      // regardless of how many tokens this address holds. Used below to
      // derive each token's threadsStarted count for its level.
      listThreads().catch(() => []),
    ]);
    const threadsStartedByToken = new Map<string, number>();
    for (const thread of threads) {
      threadsStartedByToken.set(
        thread.tokenId,
        (threadsStartedByToken.get(thread.tokenId) ?? 0) + 1,
      );
    }

    // Chunked, not one unbounded Promise.all across every token - a
    // holder with a lot of tokens (2 RPC calls each: account() + getCode())
    // firing all at once turned out to be exactly the kind of burst that
    // makes Robinhood Chain's RPC start rejecting/timing out a random
    // subset, which silently dropped those tokens' wallet info (the
    // symptom: "some of my NFTs show a wallet line, some don't" - not an
    // all-or-nothing failure, a partial one). Same concurrency-chunking
    // convention as fetchWalletTokensOnChain's own ownership checks
    // (lib/chain.ts), plus one retry per token before giving up, since a
    // single dropped request is more likely transient than a real error.
    const TBA_CONCURRENCY = 8;
    const wallets: Record<string, { address: string; activated: boolean }> = {};
    const levels: Record<string, number> = {};
    for (let i = 0; i < tokenIds.length; i += TBA_CONCURRENCY) {
      const batch = tokenIds.slice(i, i + TBA_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (tokenId) => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const tbaAddress = await computeTbaAddress(tokenId);
              const [activated, claimed, totalPosts] = await Promise.all([
                isTbaActivated(tbaAddress),
                isTokenClaimed(tokenId).catch(() => false),
                countPostsByToken(tokenId).catch(() => 0),
              ]);
              const level = computeLevelProgress({
                claimed,
                walletActivated: activated,
                threadsStarted: threadsStartedByToken.get(tokenId) ?? 0,
                totalPosts,
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
