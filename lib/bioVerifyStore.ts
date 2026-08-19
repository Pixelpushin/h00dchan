// X bio verification records - same shape/conventions as lib/adStore.ts
// and lib/adminNotesStore.ts (plain JSON blob per key, no Redis-native
// TTL - this codebase has no existing precedent for that, so expiry is
// handled at read time from `issuedAt`, matching lib/adminMessage.ts's
// ADMIN_SESSION_MAX_AGE_MS pattern).
//
// One record per tokenId (a token can only have one active claim at a
// time - claiming a new handle overwrites the old attempt). A separate
// ZSET indexes "currently verified" records specifically, since the
// bi-weekly recheck cron only needs to re-scan those, not the (likely
// much larger) set of expired/never-completed pending attempts.
import { redisCommand } from "@/lib/store";

export type BioVerificationStatus = "pending" | "verified" | "revoked";

export interface BioVerification {
  tokenId: string;
  address: string;
  xHandle: string;
  phrase: string;
  status: BioVerificationStatus;
  issuedAt: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
}

// A pending challenge older than this was never completed - treated as
// expired, holder needs to request a fresh phrase rather than post a stale
// one. Generous enough to actually go post it (X isn't instant), tight
// enough that a leaked/screenshotted phrase doesn't stay claimable forever.
export const PENDING_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const VERIFIED_INDEX_KEY = "bio-verify:verified-index";

function recordKey(tokenId: string): string {
  return `bio-verify:${tokenId}`;
}

export async function getBioVerification(
  tokenId: string,
): Promise<BioVerification | null> {
  const raw = await redisCommand("GET", recordKey(tokenId));
  return typeof raw === "string" ? (JSON.parse(raw) as BioVerification) : null;
}

async function writeBioVerification(record: BioVerification): Promise<void> {
  await redisCommand("SET", recordKey(record.tokenId), JSON.stringify(record));
  if (record.status === "verified") {
    await redisCommand(
      "ZADD",
      VERIFIED_INDEX_KEY,
      Date.parse(record.verifiedAt ?? record.issuedAt),
      record.tokenId,
    );
  } else {
    await redisCommand("ZREM", VERIFIED_INDEX_KEY, record.tokenId);
  }
}

export async function startBioVerification(
  tokenId: string,
  address: string,
  xHandle: string,
  phrase: string,
): Promise<BioVerification> {
  const record: BioVerification = {
    tokenId,
    address,
    xHandle: xHandle.replace(/^@/, "").toLowerCase(),
    phrase,
    status: "pending",
    issuedAt: new Date().toISOString(),
    verifiedAt: null,
    lastCheckedAt: null,
  };
  await writeBioVerification(record);
  return record;
}

export async function markBioVerified(
  tokenId: string,
): Promise<BioVerification | null> {
  const record = await getBioVerification(tokenId);
  if (!record) return null;
  const now = new Date().toISOString();
  const updated: BioVerification = {
    ...record,
    status: "verified",
    verifiedAt: now,
    lastCheckedAt: now,
  };
  await writeBioVerification(updated);
  return updated;
}

export async function markBioRevoked(
  tokenId: string,
): Promise<BioVerification | null> {
  const record = await getBioVerification(tokenId);
  if (!record) return null;
  const updated: BioVerification = {
    ...record,
    status: "revoked",
    lastCheckedAt: new Date().toISOString(),
  };
  await writeBioVerification(updated);
  return updated;
}

export async function touchBioLastChecked(tokenId: string): Promise<void> {
  const record = await getBioVerification(tokenId);
  if (!record) return;
  record.lastCheckedAt = new Date().toISOString();
  await redisCommand("SET", recordKey(tokenId), JSON.stringify(record));
}

// Every currently-verified tokenId, oldest-verified first - the order the
// bi-weekly recheck cron processes them in, so a run that gets cut short
// (serverless timeout) still made progress on the longest-unchecked ones
// rather than always re-doing the same head of the list.
export async function listVerifiedTokenIds(): Promise<string[]> {
  return (await redisCommand("ZRANGE", VERIFIED_INDEX_KEY, 0, -1)) as string[];
}

export function isPendingExpired(record: BioVerification): boolean {
  return Date.now() - Date.parse(record.issuedAt) > PENDING_MAX_AGE_MS;
}
