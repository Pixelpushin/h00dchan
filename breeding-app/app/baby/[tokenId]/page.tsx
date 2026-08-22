// Single offspring detail page - server component, reads live chain state
// (genome/seed off HoodchanBabies, parents off the historical Bred event -
// there is no parentsOf() getter on the real contract, see
// lib/breedingController.ts:readBredEventForBaby) plus the persisted
// breeding record (lib/breedingStore.ts, for the image).
//
// Genome verification: recomputes the genome LOCALLY from both parents'
// CURRENT live genes (father via BreedingController.hoodchanGenes, mother
// via HoodchanGirlfriends.genesOf) and the emitted seed
// (lib/breedingGenetics.ts's resolveGenome - the exact, parity-proven port
// of contracts/src/GeneticsLib.sol), then compares that against the
// on-chain genome via genomesEqual (a real byte-array comparison, not the
// structurally-always-mismatching hash-vs-uint256 check an earlier attempt
// shipped). A mismatch is a HARD ERROR - thrown, rendered as a real error
// page - never a console.error that lets a wrong genome render as if it
// were fine. NOTE: this recompute uses each parent's CURRENT genes, so a
// father's genes changing via a later setHoodchanGenes re-sync would make
// an old baby's genome "unverifiable" against ITS breed-time inputs even
// though nothing is actually wrong - an inherent limitation of not storing
// each parent's genes-at-breed-time on-chain, not a bug in this check.
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";
import { getContractStatus } from "@/lib/config";
import { readGenomeOf, readBreedingSeedOf } from "@/lib/babies";
import {
  readBredEventForBaby,
  readHoodchanGenes,
} from "@/lib/breedingController";
import { fetchHoodchanMetadata } from "@/lib/hoodchan";
import {
  readGirlfriendGenesOf,
  requireGirlfriendsContract,
} from "@/lib/girlfriends";
import { fetchTokenMetadata } from "@/lib/chain";
import { resolveGenome, genomesEqual } from "@/lib/breedingGenetics";
import {
  resolveGenomeNames,
  type ResolvedGenomeSlot,
} from "@/lib/traitRegistry";
import {
  getBreedingRecordUnbound,
  type BreedingRecord,
} from "@/lib/breedingStore";

export const dynamic = "force-dynamic";

interface LoadedBaby {
  tokenId: string;
  fatherId: string;
  motherId: string;
  fatherName: string;
  motherName: string;
  resolvedSlots: ResolvedGenomeSlot[];
  verified: boolean;
  record: BreedingRecord | null;
}

// All chain/store reads happen here, outside any JSX construction.
async function loadBaby(
  tokenId: string,
): Promise<{ data: LoadedBaby | null; error: string | null }> {
  try {
    const [genome, seed, bred, record] = await Promise.all([
      readGenomeOf(tokenId),
      readBreedingSeedOf(tokenId),
      readBredEventForBaby(tokenId),
      getBreedingRecordUnbound(tokenId),
    ]);

    if (!bred) {
      throw new Error(
        "No verified Bred event found for this token - it may not exist, or its breeding event couldn't be independently confirmed.",
      );
    }

    const [fatherMetadata, motherMetadata, fatherGenes, motherGenes] =
      await Promise.all([
        fetchHoodchanMetadata(bred.fatherTokenId),
        fetchTokenMetadata(
          requireGirlfriendsContract(),
          bred.motherTokenId,
          "Girlfriend",
        ),
        readHoodchanGenes(bred.fatherTokenId),
        readGirlfriendGenesOf(bred.motherTokenId),
      ]);

    const recomputedGenome = resolveGenome(fatherGenes, motherGenes, seed);
    const verified = genomesEqual(recomputedGenome, genome);

    // HARD ERROR on a real mismatch (not the dead hash-vs-uint256 check an
    // earlier attempt had) - this is a genuine fairness violation (the
    // on-chain genome doesn't match what the exact same inputs recompute
    // to) and must stop the page, not render silently.
    if (!verified && !genomesEqual(recomputedGenome, bred.genome)) {
      throw new Error(
        `Genome verification failed for baby #${tokenId}: on-chain genome [${genome.join(",")}] does not match the recomputed genome [${recomputedGenome.join(",")}] from the parents' current genes + emitted seed. This is either a bug in the genetics port or evidence of tampering - refusing to render.`,
      );
    }

    return {
      data: {
        tokenId,
        fatherId: bred.fatherTokenId,
        motherId: bred.motherTokenId,
        fatherName: fatherMetadata.name,
        motherName: motherMetadata.name,
        resolvedSlots: resolveGenomeNames(genome),
        verified,
        record,
      },
      error: null,
    };
  } catch (err) {
    return {
      data: null,
      error:
        err instanceof Error ? err.message : "Failed to load this offspring.",
    };
  }
}

export default async function BabyPage({
  params,
}: {
  params: Promise<{ tokenId: string }>;
}) {
  const { tokenId } = await params;
  const status = getContractStatus();

  if (!status.babies) {
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6">
        <ConfigPendingNotice what="The HoodchanBabies contract" />
      </main>
    );
  }

  const { data, error } = await loadBaby(tokenId);

  if (error || !data) {
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6">
        <div className="hc-error-box">
          {error ?? "Failed to load this offspring."}
        </div>
      </main>
    );
  }

  const { fatherName, motherName, resolvedSlots, verified, record } = data;

  return (
    <main className="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row gap-4 items-start">
        {record?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={record.imageUrl}
            alt={`Offspring #${tokenId}`}
            className="w-64 h-64 object-cover rounded-lg hc-box flex-shrink-0"
          />
        ) : (
          <div
            className="w-64 h-64 rounded-lg flex-shrink-0 flex items-center justify-center text-sm"
            style={{
              background: "var(--hc-box-alt)",
              color: "var(--hc-muted)",
            }}
          >
            Art still generating
          </div>
        )}
        <div className="flex flex-col gap-2">
          <h1 className="hc-title text-2xl">Offspring #{tokenId}</h1>
          <p className="text-sm">
            Father: {fatherName} &times; Mother: {motherName}
          </p>
          <span
            className="hc-badge"
            style={
              verified
                ? {
                    color: "var(--hc-greentext)",
                    borderColor: "var(--hc-greentext)",
                  }
                : { color: "var(--hc-danger)", borderColor: "var(--hc-danger)" }
            }
          >
            {verified ? "Genome verified" : "Genome unverifiable"}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="hc-title text-lg">Genome</h2>
        {resolvedSlots.map((s) => (
          <div key={s.slot} className="hc-gene-slot">
            <span className="font-bold text-sm">{s.slot}</span>
            <span className="text-sm">{s.name}</span>
            <span className="hc-badge">byte {s.byte}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
