import { NextResponse } from "next/server";
import { getContractStatus, HOODCHAN_CONTRACT } from "@/lib/config";
import { fetchWalletTokensOnChain } from "@/lib/chain";
import { fetchGirlfriendsWithNestedBabies } from "@/lib/girlfriends";
import { fetchHoodchanMetadata } from "@/lib/hoodchan";
import { readSiringListing } from "@/lib/breedingController";

// Everything app/my/page.tsx needs in one call: the wallet's own Girlfriends
// (each with her nested-offspring state via her TBA - purely informational
// now, see lib/girlfriends.ts's header: nesting is a voluntary post-breed
// action, not a breeding-flow gate, so there's no cap to show/grey-out
// anymore), plus the wallet's own HOODCHANs (each with current
// siring-listing state, for the set/edit/delist UI - owner-only in the UI,
// and the contract itself enforces it again on-chain regardless, checked
// live against `ownerOf` per BreedingController.listSiring/unlistSiring).
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const status = getContractStatus();

  try {
    // HOODCHAN itself is always deployed - this half of the page always
    // works even while the breeding contracts are still pending.
    const hoodchanIds = await fetchWalletTokensOnChain(
      HOODCHAN_CONTRACT,
      address,
    );
    const hoodchans = await Promise.all(
      hoodchanIds.map(async (tokenId) => {
        const metadata = await fetchHoodchanMetadata(tokenId).catch(() => null);
        const listing = status.breedingController
          ? await readSiringListing(HOODCHAN_CONTRACT, tokenId).catch(
              () => null,
            )
          : null;
        return {
          tokenId,
          name: metadata?.name ?? `Anon #${tokenId}`,
          image: metadata?.image ?? "",
          listed: listing?.listed ?? false,
          price: listing?.price?.toString() ?? "0",
        };
      }),
    );

    const girlfriends = status.girlfriends
      ? await fetchGirlfriendsWithNestedBabies(address)
      : [];

    return NextResponse.json({
      hoodchans,
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
