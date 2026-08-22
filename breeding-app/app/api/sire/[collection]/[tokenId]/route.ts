import { NextResponse } from "next/server";
import { getContractStatus } from "@/lib/config";
import {
  readSiringListing,
  readBreedState,
  readHoodchanGenesSet,
} from "@/lib/breedingController";
import {
  collectionKindOf,
  fetchTokenDisplay,
  readSexFor,
  computeCooldownStatus,
} from "@/lib/collections";
import { readOwnerOf } from "@/lib/chain";

// Single token's live listing + metadata + cooldown + sex-tag state -
// powers the breed page's pre-selected-sire header (price, cooldown,
// "you own this one" free-siring detection) for a token from ANY of the
// three allowlisted collections, not just HOODCHAN (v1's
// app/api/sire/[hoodchanId] name/shape). v2: no more ETH eligibility
// (CHAN-only fees) or fatherLocked (the superseded commit/reveal escrow's
// lock state) - see the design spec's "Explicitly cut from scope" section.
// `cooldownEnd`/`breedCount` replace it (the design spec's escalating
// per-token cooldown, not the superseded v1 nested-cap).
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ collection: string; tokenId: string }> },
) {
  const { collection, tokenId } = await params;
  const status = getContractStatus();
  if (!status.breedingController) {
    return NextResponse.json({ pending: true });
  }

  const kind = collectionKindOf(collection);
  if (!kind) {
    return NextResponse.json(
      { error: "Not an allowlisted breedable collection." },
      { status: 400 },
    );
  }

  try {
    const [listing, breedState, display, owner, isMale, genesSet] =
      await Promise.all([
        readSiringListing(collection, tokenId),
        readBreedState(collection, tokenId),
        fetchTokenDisplay(collection, tokenId),
        readOwnerOf(collection, tokenId),
        readSexFor(collection, tokenId),
        // Only HOODCHAN has an off-chain gene-sync trust point (see
        // lib/breedingController.ts's HOODCHAN ADAPTER note) - Girlfriends
        // and Babies genes are always set at mint, so this is always true
        // for them.
        kind === "hoodchan"
          ? readHoodchanGenesSet(tokenId)
          : Promise.resolve(true),
      ]);
    return NextResponse.json({
      pending: false,
      collection,
      kind,
      tokenId,
      owner,
      isMale,
      genesSet,
      price: listing.price.toString(),
      listed: listing.listed,
      cooldown: computeCooldownStatus(breedState),
      name: display.name,
      image: display.image,
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
