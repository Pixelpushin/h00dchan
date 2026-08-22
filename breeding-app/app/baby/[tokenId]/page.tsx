// Single offspring detail page - server component, reads live chain state
// (genome/seed/sex off HoodchanBabies, parents off the historical Bred
// event - there is no parentsOf() getter on the real contract, see
// lib/breedingController.ts:readBredEventForBaby) plus the persisted
// breeding record (lib/breedingStore.ts, for the image).
//
// Genome verification: recomputes the genome LOCALLY from both parents'
// CURRENT live genes (any of the three allowlisted collections - see
// readParentGenes below) and the emitted seed (lib/breedingGenetics.ts's
// resolveGenome - the exact, parity-proven port of
// contracts/src/GeneticsLib.sol), then compares that against the on-chain
// genome via genomesEqual (a real byte-array comparison). A mismatch is a
// HARD ERROR - thrown, rendered as a real error page - never silently
// rendered as if it were fine. NOTE: this recompute uses each parent's
// CURRENT genes, so a HOODCHAN parent's genes changing via a later
// setHoodchanGenes re-sync would make an old baby's genome "unverifiable"
// against ITS breed-time inputs even though nothing is actually wrong - an
// inherent limitation of not storing each parent's genes-at-breed-time
// on-chain, not a bug in this check.
import Link from "next/link";
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";
import { getContractStatus, BABIES_CONTRACT } from "@/lib/config";
import {
  readGenesOf as readBabyGenesOf,
  readBreedingSeedOf,
} from "@/lib/babies";
import { readBredEventForBaby } from "@/lib/breedingController";
import {
  readGenesFor,
  fetchTokenDisplay,
  collectionLabel,
} from "@/lib/collections";
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
  matronCollection: string;
  matronId: string;
  sireCollection: string;
  sireId: string;
  matronName: string;
  sireName: string;
  babyIsMale: boolean;
  isTestTubeBaby: boolean;
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
      readBabyGenesOf(tokenId),
      readBreedingSeedOf(tokenId),
      readBredEventForBaby(tokenId),
      getBreedingRecordUnbound(tokenId),
    ]);

    if (!bred) {
      throw new Error(
        "No verified Bred event found for this token - it may not exist, or its breeding event couldn't be independently confirmed.",
      );
    }

    const [matronDisplay, sireDisplay, matronGenes, sireGenes] =
      await Promise.all([
        fetchTokenDisplay(bred.matronCollection, bred.matronId),
        fetchTokenDisplay(bred.sireCollection, bred.sireId),
        readGenesFor(bred.matronCollection, bred.matronId),
        readGenesFor(bred.sireCollection, bred.sireId),
      ]);
    const matronName = matronDisplay.name;
    const sireName = sireDisplay.name;

    const recomputedGenome = resolveGenome(matronGenes, sireGenes, seed);
    const verified = genomesEqual(recomputedGenome, genome);

    // HARD ERROR on a real mismatch - this is a genuine fairness violation
    // (the on-chain genome doesn't match what the exact same inputs
    // recompute to) and must stop the page, not render silently.
    if (!verified && !genomesEqual(recomputedGenome, bred.genome)) {
      throw new Error(
        `Genome verification failed for baby #${tokenId}: on-chain genome [${genome.join(",")}] does not match the recomputed genome [${recomputedGenome.join(",")}] from the parents' current genes + emitted seed. This is either a bug in the genetics port or evidence of tampering - refusing to render.`,
      );
    }

    return {
      data: {
        tokenId,
        matronCollection: bred.matronCollection,
        matronId: bred.matronId,
        sireCollection: bred.sireCollection,
        sireId: bred.sireId,
        matronName,
        sireName,
        babyIsMale: bred.babyIsMale,
        isTestTubeBaby: bred.isTestTubeBaby,
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

  const {
    matronCollection,
    matronId,
    sireCollection,
    sireId,
    matronName,
    sireName,
    babyIsMale,
    isTestTubeBaby,
    resolvedSlots,
    verified,
    record,
  } = data;

  const hype = resolvedSlots
    .map((s): "legendary" | "mutant" | null => {
      if (s.byte < 248) return null;
      return s.name.startsWith("Legendary") ? "legendary" : "mutant";
    })
    .find((v) => v !== null);

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
            Matron ({collectionLabel(matronCollection)}):{" "}
            <Link
              href={`/family/${matronCollection}/${matronId}`}
              className="hc-link"
            >
              {matronName}
            </Link>{" "}
            &times; Sire ({collectionLabel(sireCollection)}):{" "}
            <Link
              href={`/family/${sireCollection}/${sireId}`}
              className="hc-link"
            >
              {sireName}
            </Link>
          </p>
          <p className="text-sm">Sex: {babyIsMale ? "Male" : "Female"}</p>
          <div className="flex flex-wrap gap-2 items-center">
            {hype === "legendary" && (
              <span className="hc-badge hc-badge-legendary">
                ✨ Legendary roll
              </span>
            )}
            {hype === "mutant" && (
              <span className="hc-badge hc-badge-mutation">🧬 Mutation</span>
            )}
            {isTestTubeBaby && (
              <span className="hc-badge hc-badge-testtube">
                🧪 Test Tube Baby
              </span>
            )}
            <span
              className="hc-badge"
              style={
                verified
                  ? {
                      color: "var(--hc-greentext)",
                      borderColor: "var(--hc-greentext)",
                    }
                  : {
                      color: "var(--hc-danger)",
                      borderColor: "var(--hc-danger)",
                    }
              }
            >
              {verified ? "Genome verified" : "Genome unverifiable"}
            </span>
          </div>
          {BABIES_CONTRACT && (
            <Link
              href={`/family/${BABIES_CONTRACT}/${tokenId}`}
              className="hc-link text-sm"
            >
              View family tree
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="hc-title text-lg">Genome</h2>
        {resolvedSlots.map((s) => {
          const slotHype =
            s.byte >= 248
              ? s.name.startsWith("Legendary")
                ? "legendary"
                : "mutant"
              : null;
          return (
            <div
              key={s.slot}
              className={
                slotHype === "legendary"
                  ? "hc-gene-slot hc-gene-slot-legendary"
                  : slotHype === "mutant"
                    ? "hc-gene-slot hc-gene-slot-mutant"
                    : "hc-gene-slot"
              }
            >
              <span className="font-bold text-sm">{s.slot}</span>
              <span className="text-sm">{s.name}</span>
              <span
                className={
                  slotHype === "legendary"
                    ? "hc-badge hc-badge-legendary"
                    : slotHype === "mutant"
                      ? "hc-badge hc-badge-mutation"
                      : "hc-badge"
                }
              >
                byte {s.byte}
              </span>
            </div>
          );
        })}
      </div>
    </main>
  );
}
