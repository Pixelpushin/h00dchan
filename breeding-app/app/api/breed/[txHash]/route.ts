import { NextRequest, NextResponse } from "next/server";
import { getContractStatus, BREEDING_CONTROLLER_CONTRACT } from "@/lib/config";
import { rpcCall } from "@/lib/chain";
import { parseBredEventFromLogs, type RawLog } from "@/lib/breedingController";
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
import { checkExpensiveScanRateLimit } from "@/lib/rateLimit";

// Polled by app/breed/[collection]/[tokenId]/page.tsx after the single
// breed() tx is
// sent (v2: no commit/reveal two-step anymore - see the design spec's
// "Breeding flow" section). Generates + persists the offspring art
// (idempotent: an already-finished baby is just read back from the store
// on later polls for the SAME txHash) and returns the finished offspring.
// Every step here reads live chain state or calls a live upstream
// (OpenAI/Blob), so this must never be statically cached.
export const dynamic = "force-dynamic";

interface Receipt {
  to: string | null;
  status: string;
  logs: RawLog[];
}

async function receiptFor(txHash: string): Promise<Receipt | null> {
  return rpcCall<Receipt | null>("eth_getTransactionReceipt", [txHash]);
}

// BUG 5(a) defense-in-depth, part (b): beyond checking each individual
// log's `address` (done inside parseBredEventFromLogs), also verify the
// RECEIPT's own `to` field is the configured controller - i.e. this was
// actually a call INTO BreedingController, not merely a transaction that
// happens to contain a log emitted by it (e.g. via an internal call from
// some other contract). Both checks are cheap and independent; neither
// alone is assumed sufficient.
function verifyReceiptTargetsController(
  receipt: Receipt,
  controllerAddress: string,
): boolean {
  return receipt.to?.toLowerCase() === controllerAddress.toLowerCase();
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ txHash: string }> },
) {
  // Hygiene requirement (design spec's "Hygiene requirements" section, plus
  // the task's own rate-limiting requirement): this route does a full
  // receipt fetch + Bred-event decode on every poll, and on a cache miss
  // additionally triggers a real OpenAI image generation + Blob write -
  // reachable with nothing more than a syntactically-shaped txHash in the
  // URL, so it needs a budget in front of it regardless of the fee-based
  // throttle on breeding itself. See lib/rateLimit.ts's header for why this
  // is a local fork rather than an import from the parent app.
  const rateLimit = checkExpensiveScanRateLimit(req.headers);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests - slow down and try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

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

    const bred = parseBredEventFromLogs(receipt.logs, controllerAddress);
    if (!bred) {
      return NextResponse.json(
        { error: "Transaction mined but no Bred event was found." },
        { status: 502 },
      );
    }

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

    const { blobUrl, prompt } = await generateBreedingImage(genomeForPrompt);

    const record: BreedingRecord = {
      babyId: bred.babyTokenId,
      matronCollection: bred.matronCollection,
      matronId: bred.matronId,
      sireCollection: bred.sireCollection,
      sireId: bred.sireId,
      seed: bred.seed.toString(),
      genome: bred.genome,
      slots: resolvedSlots,
      babyIsMale: bred.babyIsMale,
      isTestTubeBaby: bred.isTestTubeBaby,
      imageUrl: blobUrl,
      prompt,
      createdAt: new Date().toISOString(),
      txHash,
      controllerAddress: controllerAddress.toLowerCase(),
    };
    await saveBreedingRecord(record);

    return NextResponse.json({ state: "ready", baby: record });
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
