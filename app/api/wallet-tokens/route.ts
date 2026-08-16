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
    const [tokenIds, lastScannedBlock] = await Promise.all([
      fetchWalletTokensOnChain(address, { fromBlock, knownTokenIds }),
      readBlockNumber(),
    ]);

    const walletEntries = await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          const tbaAddress = await computeTbaAddress(tokenId);
          const activated = await isTbaActivated(tbaAddress);
          return [tokenId, { address: tbaAddress, activated }] as const;
        } catch {
          return null;
        }
      }),
    );
    const wallets = Object.fromEntries(
      walletEntries.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      ),
    );

    return NextResponse.json({ tokenIds, lastScannedBlock, wallets });
  } catch (error) {
    console.error(`Failed to load wallet tokens for ${address}`, error);
    return NextResponse.json(
      { error: "Unable to load tokens from chain right now." },
      { status: 502 },
    );
  }
}
