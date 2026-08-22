import { NextResponse } from "next/server";
import { getContractStatus, HOODCHAN_CONTRACT } from "@/lib/config";
import {
  readSiringListing,
  readHoodchanGenesSet,
  readBreedState,
} from "@/lib/breedingController";
import { fetchHoodchanMetadata } from "@/lib/hoodchan";
import { readOwnerOf } from "@/lib/chain";

// Single HOODCHAN token's live listing + metadata + cooldown state - powers
// app/breed/[hoodchanId]'s header (price, genes-ready state, cooldown)
// without re-fetching the full browse-all-sires listings array. v2: no
// more ETH eligibility (CHAN-only fees) or fatherLocked (the superseded
// commit/reveal escrow's lock state) - see the design spec's "Explicitly
// cut from scope" section. `cooldownEnd`/`breedCount` replace it.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ hoodchanId: string }> },
) {
  const { hoodchanId } = await params;
  const status = getContractStatus();
  if (!status.breedingController) {
    return NextResponse.json({ pending: true });
  }

  try {
    const [listing, genesSet, breedState, metadata, owner] = await Promise.all([
      readSiringListing(HOODCHAN_CONTRACT, hoodchanId),
      readHoodchanGenesSet(hoodchanId),
      readBreedState(HOODCHAN_CONTRACT, hoodchanId),
      fetchHoodchanMetadata(hoodchanId),
      readOwnerOf(HOODCHAN_CONTRACT, hoodchanId),
    ]);
    return NextResponse.json({
      pending: false,
      hoodchanId,
      owner,
      price: listing.price.toString(),
      listed: listing.listed,
      genesSet,
      breedCount: breedState.breedCount,
      cooldownEnd: breedState.cooldownEnd.toString(),
      name: metadata.name,
      image: metadata.image,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to load this sire.",
      },
      { status: 502 },
    );
  }
}
