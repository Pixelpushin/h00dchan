import { NextResponse } from "next/server";
import { getBreedingRecordUnbound } from "@/lib/breedingStore";
import { SLOT_LABEL, type GeneSlot } from "@/lib/traitRegistry";

// Standard OpenSea-schema NFT metadata, served by this app itself - the
// Babies contract's tokenURI(tokenId) is expected to point here (via
// HoodchanBabies.setTokenURI, set once the offspring's art/metadata is
// ready - see contracts/src/HoodchanBabies.sol). Reads the persisted
// breeding record (lib/breedingStore.ts) rather than the chain, since the
// image URL and resolved trait names live there, not on-chain (on-chain
// only stores the raw uint8[5] genome).
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const { tokenId } = await params;
  const record = await getBreedingRecordUnbound(tokenId);
  if (!record) {
    return NextResponse.json(
      { error: "This offspring hasn't finished breeding yet." },
      { status: 404 },
    );
  }
  return NextResponse.json({
    name: `HOODCHAN Offspring #${record.babyId}`,
    description:
      "A HOODCHAN-ecosystem offspring, bred from any two of the HOODCHAN, " +
      "Girlfriends, and Babies collections - genome inherited from both " +
      "parents, five gene slots each real, mutated, or legendary." +
      (record.isTestTubeBaby
        ? " A Test Tube Baby - sired via a same-sex pairing."
        : ""),
    image: record.imageUrl,
    attributes: [
      ...record.slots.map((s) => ({
        trait_type: SLOT_LABEL[s.slot as GeneSlot],
        value: s.name,
      })),
      {
        trait_type: "Matron",
        value: `${record.matronCollection}#${record.matronId}`,
      },
      {
        trait_type: "Sire",
        value: `${record.sireCollection}#${record.sireId}`,
      },
      { trait_type: "Sex", value: record.babyIsMale ? "Male" : "Female" },
      {
        trait_type: "Test Tube Baby",
        value: record.isTestTubeBaby ? "Yes" : "No",
      },
    ],
  });
}
