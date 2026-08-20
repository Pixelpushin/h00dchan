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
import { readOwnerOf } from "@/lib/chain";

// Same one-retry-with-backoff shape as lib/holderAuth.ts/lib/adPayment.ts -
// Robinhood Chain's public RPC is documented elsewhere in this codebase as
// intermittently flaky under load. Without a retry, a single transient
// blip here fails isStillOwnedByVerifier closed (see below), which used to
// mean a real, still-valid verification could flicker to "not currently
// verified" on nothing more than bad luck.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

export type BioVerificationStatus = "pending" | "verified" | "revoked";

export interface BioVerification {
  tokenId: string;
  address: string;
  xHandle: string;
  phrase: string; // full text shown/copied - includes the site tag
  checkText: string; // what's actually matched against the bio - see
  // lib/bioVerifyPhrase.ts's sentenceFromSeed for why this differs from
  // `phrase` (X auto-linkifies the site tag away on save)
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

// The +200 XP badge is keyed by tokenId, but `record.address` is a wallet,
// not the token - unlike hodlerWeeks/isTopHolder/nestedHoldingCount (see
// lib/leveling.ts / lib/collectionSnapshot.ts), which all recompute live
// from current ownership, a naive "record exists and status is verified"
// check would let the badge silently transfer to whoever buys the token
// next, forever, even though they never proved anything. This re-confirms
// the token's CURRENT on-chain owner still matches the wallet that signed
// the original challenge before treating a record as verified. It never
// touches storage either way: a lapsed match just stops counting until the
// original verifier reacquires the token, at which point this starts
// returning true again automatically with zero re-verification needed.
async function isStillOwnedByVerifier(
  record: BioVerification,
  currentOwner?: string,
): Promise<boolean> {
  // Callers that already resolved current ownership this request (e.g. a
  // leaderboard pass walking lib/collectionSnapshot.ts's ownerOfToken map)
  // can pass it straight in and skip a redundant RPC call. Everyone else
  // falls back to a live ownerOf() read via lib/chain.ts - the same helper
  // every other single-token ownership check in this codebase already uses,
  // no new RPC plumbing.
  const owner =
    currentOwner ??
    (await withRetry(() => readOwnerOf(record.tokenId)).catch(() => null));
  // Can't prove current ownership right now (RPC hiccup, all 3 attempts
  // failed) - fail closed, same as weeksHeld/isTopHolder returning 0/false
  // when their snapshot data is missing, rather than trusting a stale
  // claim. The retry above means this only actually triggers on a genuine
  // sustained outage, not a single blip.
  if (!owner) return false;
  return owner.toLowerCase() === record.address.toLowerCase();
}

export async function getBioVerification(
  tokenId: string,
  currentOwner?: string,
): Promise<BioVerification | null> {
  const raw = await redisCommand("GET", recordKey(tokenId));
  const record =
    typeof raw === "string" ? (JSON.parse(raw) as BioVerification) : null;
  if (!record || record.status !== "verified") return record;

  if (await isStillOwnedByVerifier(record, currentOwner)) return record;

  // Token changed hands since verification - report it as not-currently-
  // verified to every caller (they all key off `.status === "verified"`)
  // WITHOUT persisting anything. This is a computed, in-memory-only status
  // flip; the stored record (and the verified-index ZSET) is untouched, so
  // the original verifier regains the badge the instant they own the token
  // again, and the bi-weekly recheck cron (this file's own
  // listVerifiedTokenIds, below) simply skips re-checking the bio for it in
  // the meantime rather than mistakenly revoking a still-valid verification.
  return { ...record, status: "revoked" };
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
  checkText: string,
): Promise<BioVerification> {
  const record: BioVerification = {
    tokenId,
    address,
    xHandle: xHandle.replace(/^@/, "").toLowerCase(),
    phrase,
    checkText,
    status: "pending",
    issuedAt: new Date().toISOString(),
    verifiedAt: null,
    lastCheckedAt: null,
  };
  await writeBioVerification(record);
  return record;
}

function handleOwnerKey(xHandle: string): string {
  return `bio-verify:handle-owner:${xHandle.toLowerCase()}`;
}

export async function markBioVerified(
  tokenId: string,
): Promise<BioVerification | null> {
  const record = await getBioVerification(tokenId);
  if (!record) return null;

  // One X account can only ever back ONE currently-verified token's badge
  // at a time - without this, the same handle could verify every token in
  // a wallet and collect the +200 XP milestone once per token instead of
  // once ever, a bigger version of the exact nested-holding XP exploit
  // this codebase already capped elsewhere. If this handle currently backs
  // a DIFFERENT token, revoke that one first, then verify the new one - if
  // something fails between these two writes, the failure mode is "this
  // handle has zero verified tokens for a moment," never two.
  const key = handleOwnerKey(record.xHandle);
  const existingTokenId = (await redisCommand("GET", key)) as string | null;
  if (existingTokenId && existingTokenId !== tokenId) {
    const previous = await getBioVerification(existingTokenId);
    if (previous && previous.status === "verified") {
      await writeBioVerification({
        ...previous,
        status: "revoked",
        lastCheckedAt: new Date().toISOString(),
      });
    }
  }

  const now = new Date().toISOString();
  const updated: BioVerification = {
    ...record,
    status: "verified",
    verifiedAt: now,
    lastCheckedAt: now,
  };
  await writeBioVerification(updated);
  await redisCommand("SET", key, tokenId);
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

// Reads the raw stored record directly - NOT getBioVerification, which
// recomputes current ownership via a live RPC call. Was a real bug: every
// call to this function did a second, redundant ownership check (the
// caller - the bio-recheck cron - had already just confirmed ownership via
// its own getBioVerification call moments earlier), and if THAT second
// check hit a transient RPC hiccup, getBioVerification's fail-closed
// computed "revoked" status got written straight to storage as if it were
// real - permanently downgrading a still-valid verification and leaving
// the verified-index ZSET pointing at a record that no longer says
// "verified" (writeBioVerification's index sync was bypassed too, via a
// raw SET). This only ever bumps lastCheckedAt on the record as it
// actually exists on disk, through writeBioVerification so the index stays
// consistent.
export async function touchBioLastChecked(tokenId: string): Promise<void> {
  const raw = await redisCommand("GET", recordKey(tokenId));
  const record =
    typeof raw === "string" ? (JSON.parse(raw) as BioVerification) : null;
  if (!record) return;
  await writeBioVerification({
    ...record,
    lastCheckedAt: new Date().toISOString(),
  });
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
