import { NextResponse } from "next/server";
import { getContractStatus, HOODCHAN_CONTRACT } from "@/lib/config";
import {
  readSiringListing,
  readHoodchanGenesSet,
  readUpgradedAllowlist,
  readFatherLocked,
} from "@/lib/breedingController";
import { fetchHoodchanMetadata, isUpgraded } from "@/lib/hoodchan";
import { readOwnerOf } from "@/lib/chain";

// Single sire's live listing + metadata - powers app/breed/[hoodchanId]'s
// header (price, ETH eligibility, genes-ready state, lock state) without
// re-fetching the full browse-all-sires listings array.
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
    const [listing, genesSet, upgraded, fatherLocked, metadata, owner] =
      await Promise.all([
        readSiringListing(hoodchanId),
        readHoodchanGenesSet(hoodchanId),
        readUpgradedAllowlist(hoodchanId),
        readFatherLocked(hoodchanId),
        fetchHoodchanMetadata(hoodchanId),
        readOwnerOf(HOODCHAN_CONTRACT, hoodchanId),
      ]);
    return NextResponse.json({
      pending: false,
      hoodchanId,
      owner,
      chanPrice: listing.chanPrice.toString(),
      ethPrice: listing.ethPrice.toString(),
      listed: listing.listed,
      genesSet,
      // Same dual-signal rule as app/api/listings/route.ts.
      ethEligible: upgraded && isUpgraded(metadata),
      fatherLocked,
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
