// Off-chain record store for a finished offspring - image URL, prompt, and
// resolved trait names. No database is available to this app (its env var
// surface is deliberately just contract addresses + NEXT_PUBLIC_REOWN_
// PROJECT_ID + OPENAI_API_KEY + BLOB_READ_WRITE_TOKEN + ALCHEMY_API_KEY),
// so this uses Vercel Blob itself as a tiny JSON-per-baby store: one fixed,
// overwrite-safe pathname per babyId, looked up via list({prefix}) rather
// than a predictable base URL (Blob store URLs are per-deployment and not
// knowable in advance). This is what the Babies contract's tokenURI(id)
// resolves to in practice, via app/api/baby-metadata/[tokenId]/route.ts.
//
// BUG 5(b) fix (pre-population hijack): an earlier attempt wrote to
// `breeding/records/{babyId}.json` with only an "does a record already
// exist" idempotency check, and combined with BUG 5(a) (no address check on
// the parsed Bred log), an attacker could send ANY transaction whose logs
// merely happened to shape-match a Bred event, choose an arbitrary
// (not-yet-real) babyId, and pre-write a forged record for it - poisoning
// the idempotency check so the REAL breeding result for that babyId would
// be silently discarded forever once it actually happened.
//
// The fix here is binding: every record is written and read together with
// the (txHash, controllerAddress) pair of the REAL, address-verified Bred
// log it came from (see lib/breedingController.ts's parseBredEventFromLogs,
// which is the only place allowed to produce a BredEventResult in the first
// place - BUG 5(a) closes off forged logs before they ever reach this
// module). getBreedingRecord requires the caller to supply the txHash it
// expects the stored record to be bound to; a record whose bound txHash
// doesn't match is treated as untrusted and never returned, forcing the
// caller (app/api/breed/[txHash]/route.ts) to regenerate it fresh from its
// own verified log instead of trusting whatever is sitting in Blob. The
// route stays idempotent for repeated polls of the SAME legitimate txHash
// (no double art generation), since that txHash will keep matching.
import { put, list } from "@vercel/blob";

export interface BreedingRecordSlot {
  slot: string;
  byte: number;
  name: string;
}

export interface BreedingRecord {
  babyId: string;
  fatherId: string;
  motherId: string;
  seed: string; // stringified bigint
  genome: number[];
  slots: BreedingRecordSlot[];
  imageUrl: string;
  prompt: string;
  createdAt: string;
  // Binding - see this file's header. Both fields are required on write;
  // getBreedingRecord refuses to return a record whose binding doesn't
  // match what the caller expects.
  txHash: string;
  controllerAddress: string;
}

function pathFor(babyId: string): string {
  return `breeding/records/${babyId}.json`;
}

export async function saveBreedingRecord(
  record: BreedingRecord,
): Promise<void> {
  await put(pathFor(record.babyId), JSON.stringify(record), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

// Returns the stored record for `babyId` ONLY if it exists AND its bound
// (txHash, controllerAddress) matches what the caller supplies. Returns
// null both when nothing is stored yet AND when something is stored but
// doesn't match - callers must treat both cases identically (regenerate
// from a freshly-verified source), never distinguish "untrusted record
// found" from "no record found" in a way that could leak whether a forged
// write attempt landed.
export async function getBreedingRecord(
  babyId: string,
  expected: { txHash: string; controllerAddress: string },
): Promise<BreedingRecord | null> {
  try {
    const { blobs } = await list({ prefix: pathFor(babyId), limit: 1 });
    const blob = blobs[0];
    if (!blob) return null;
    const res = await fetch(blob.url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const record = (await res.json()) as BreedingRecord;
    if (
      record.txHash?.toLowerCase() !== expected.txHash.toLowerCase() ||
      record.controllerAddress?.toLowerCase() !==
        expected.controllerAddress.toLowerCase()
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

// Unbound read for display-only paths that already trust the babyId itself
// came from a live chain read (e.g. app/baby/[tokenId]/page.tsx, which only
// ever reaches this store after independently confirming the token exists
// via HoodchanBabies.genomeOf - there is no "guess a future babyId" attack
// surface there the way there is for the breed-polling route, since a
// genomeOf() call for a token that hasn't minted yet simply reverts).
export async function getBreedingRecordUnbound(
  babyId: string,
): Promise<BreedingRecord | null> {
  try {
    const { blobs } = await list({ prefix: pathFor(babyId), limit: 1 });
    const blob = blobs[0];
    if (!blob) return null;
    const res = await fetch(blob.url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    return (await res.json()) as BreedingRecord;
  } catch {
    return null;
  }
}
