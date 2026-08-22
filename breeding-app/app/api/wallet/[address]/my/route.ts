import { NextResponse } from "next/server";
import { getContractStatus } from "@/lib/config";
import { fetchOwnedBreedableTokens } from "@/lib/collections";
import { fetchGirlfriendsWithNestedBabies } from "@/lib/girlfriends";
import { readSiringListing } from "@/lib/breedingController";

// Everything app/my/page.tsx needs in one call: the wallet's own tokens
// across ALL THREE allowlisted collections (each with current
// siring-listing state, for the set/edit/delist UI - owner-only in the UI,
// and the contract itself enforces it again on-chain regardless, checked
// live against `ownerOf` per BreedingController.listSiring/unlistSiring),
// plus the wallet's own Girlfriends' nested-offspring state (purely
// informational, see lib/girlfriends.ts's header: nesting is a voluntary
// post-breed action, not a breeding-flow gate, so there's no cap to
// show/grey-out anymore).
//
// v2: siring listings are CHAN-only (the v1 dual-currency ETH price field
// is dropped entirely) and generalized to any of the three collections, not
// just HOODCHAN - see the design spec's "Fees" and "Collections and the
// breedable allowlist" sections. `listed` is an explicit boolean, never
// inferred from `price === 0` (price 0 while listed = free but listed, per
// the design spec's siring-listing note).
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const status = getContractStatus();

  try {
    const ownedTokens = await fetchOwnedBreedableTokens(address);

    const tokens = await Promise.all(
      ownedTokens.map(async (t) => {
        const listing = status.breedingController
          ? await readSiringListing(t.collection, t.tokenId).catch(() => null)
          : null;
        return {
          ...t,
          listed: listing?.listed ?? false,
          price: listing?.price?.toString() ?? "0",
        };
      }),
    );

    const girlfriends = status.girlfriends
      ? await fetchGirlfriendsWithNestedBabies(address)
      : [];

    return NextResponse.json({
      tokens,
      girlfriends,
      girlfriendsPending: !status.girlfriends,
      breedingControllerPending: !status.breedingController,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to load your wallet.",
      },
      { status: 502 },
    );
  }
}
