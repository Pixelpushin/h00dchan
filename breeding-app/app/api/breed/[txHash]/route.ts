import { NextResponse } from "next/server";
import { Interface } from "ethers";
import { getContractStatus, BREEDING_CONTROLLER_CONTRACT } from "@/lib/config";
import { rpcCall } from "@/lib/chain";
import { parseBredEventFromLogs, type RawLog } from "@/lib/breedingController";
import { BreedingControllerAbi } from "@/lib/abi/BreedingController";
import { fetchHoodchanMetadata } from "@/lib/hoodchan";
import { resolveGenomeNames } from "@/lib/traitRegistry";
import {
  generateBreedingImage,
  type BreedingGenome,
} from "@/lib/breedingImage";
import {
  getBreedingRecord,
  saveBreedingRecord,
  type BreedingRecord,
} from "@/lib/breedingStore";

// Polled by app/breed/[hoodchanId]/page.tsx after EITHER step of the
// commit/reveal flow is sent:
//   - polling the commitBreed tx hash resolves the commitId (via the
//     CommitCreated event) so the UI can auto-call revealBreed once
//     eligible;
//   - polling the revealBreed tx hash resolves the final Bred event,
//     generates + persists the offspring art (idempotent: an already-
//     finished baby is just read back from the store on later polls for
//     the SAME txHash), and returns the finished offspring.
// Every step here reads live chain state or calls a live upstream
// (OpenAI/Blob), so this must never be statically cached.
export const dynamic = "force-dynamic";

const controllerInterface = new Interface(BreedingControllerAbi);
const commitCreatedFragment = controllerInterface.getEvent("CommitCreated");
if (!commitCreatedFragment) {
  throw new Error("BreedingController ABI is missing CommitCreated.");
}
const COMMIT_CREATED_TOPIC0 = commitCreatedFragment.topicHash;

interface Receipt {
  to: string | null;
  status: string;
  logs: RawLog[];
}

async function receiptFor(txHash: string): Promise<Receipt | null> {
  return rpcCall<Receipt | null>("eth_getTransactionReceipt", [txHash]);
}

// BUG 5(a) defense-in-depth, part (b): beyond checking each individual
// log's `address` (done inside parseBredEventFromLogs /
// findCommitCreated below), also verify the RECEIPT's own `to` field is
// the configured controller - i.e. this was actually a call INTO
// BreedingController, not merely a transaction that happens to contain a
// log emitted by it (e.g. via an internal call from some other contract).
// Both checks are cheap and independent; neither alone is assumed
// sufficient.
function verifyReceiptTargetsController(
  receipt: Receipt,
  controllerAddress: string,
): boolean {
  return receipt.to?.toLowerCase() === controllerAddress.toLowerCase();
}

function findCommitCreated(
  logs: RawLog[],
  controllerAddress: string,
): { commitId: string; commitBlock: string } | null {
  const controllerLower = controllerAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== controllerLower) continue;
    if (log.topics[0]?.toLowerCase() !== COMMIT_CREATED_TOPIC0.toLowerCase()) {
      continue;
    }
    try {
      const parsed = controllerInterface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (parsed?.name === "CommitCreated") {
        return {
          commitId: parsed.args.commitId.toString(),
          commitBlock: parsed.args.commitBlock.toString(),
        };
      }
    } catch {
      // fall through - not a real CommitCreated log
    }
  }
  return null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ txHash: string }> },
) {
  const { txHash } = await params;
  const status = getContractStatus();
  if (!status.breedingController || !status.babies) {
    return NextResponse.json(
      { error: "Breeding contracts are not deployed yet." },
      { status: 503 },
    );
  }
  const controllerAddress = BREEDING_CONTROLLER_CONTRACT as string;

  try {
    const receipt = await receiptFor(txHash);
    if (!receipt) {
      return NextResponse.json({ state: "pending" });
    }
    if (receipt.status === "0x0") {
      return NextResponse.json(
        { error: "Transaction reverted." },
        { status: 502 },
      );
    }
    if (!verifyReceiptTargetsController(receipt, controllerAddress)) {
      return NextResponse.json(
        { error: "Transaction was not sent to the BreedingController." },
        { status: 400 },
      );
    }

    // Try Bred first (revealBreed tx) - a tx can only ever contain one or
    // the other, but Bred is the terminal state so check it first.
    const bred = parseBredEventFromLogs(receipt.logs, controllerAddress);
    if (bred) {
      const existing = await getBreedingRecord(bred.babyTokenId, {
        txHash,
        controllerAddress,
      });
      if (existing) {
        return NextResponse.json({ state: "ready", baby: existing });
      }

      const resolvedSlots = resolveGenomeNames(bred.genome);
      const genomeForPrompt: BreedingGenome = {
        hat: resolvedSlots[0].name,
        face: resolvedSlots[1].name,
        body: resolvedSlots[2].name,
        background: resolvedSlots[3].name,
        accessory: resolvedSlots[4].name,
      };

      const [fatherMetadata, { blobUrl, prompt }] = await Promise.all([
        fetchHoodchanMetadata(bred.fatherTokenId).catch(() => null),
        generateBreedingImage(genomeForPrompt),
      ]);

      const record: BreedingRecord = {
        babyId: bred.babyTokenId,
        fatherId: bred.fatherTokenId,
        motherId: bred.motherTokenId,
        seed: bred.seed.toString(),
        genome: bred.genome,
        slots: resolvedSlots,
        imageUrl: blobUrl,
        prompt,
        createdAt: new Date().toISOString(),
        txHash,
        controllerAddress: controllerAddress.toLowerCase(),
      };
      await saveBreedingRecord(record);
      void fatherMetadata; // fetched only to warm/validate the father's metadata cache; not required for the record itself

      return NextResponse.json({ state: "ready", baby: record });
    }

    const commit = findCommitCreated(receipt.logs, controllerAddress);
    if (commit) {
      return NextResponse.json({ state: "committed", ...commit });
    }

    return NextResponse.json(
      { error: "Transaction mined but no breeding event was found." },
      { status: 502 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to resolve breeding result.",
      },
      { status: 502 },
    );
  }
}
