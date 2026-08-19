// Ad submission storage - same shape as lib/store.ts's thread/post pattern
// (ad:counter INCR for ids, ad:<id> JSON blob, ads:index ZSET for ordered
// listing), reusing that file's redisCommand rather than a second Redis
// client. A separate file, not folded into store.ts, since ad rental is a
// distinct product surface (payments, review queue) from the board itself.
import { redisCommand } from "@/lib/store";
import { AD_SLOT_DAYS } from "@/lib/adConfig";

export type AdStatus = "pending_review" | "active" | "rejected";

export interface AdSubmission {
  id: string;
  openseaUrl: string;
  name: string;
  imageUrl: string;
  avatarUrl: string;
  submitterAddress: string;
  tokenSymbol: string;
  txHash: string;
  status: AdStatus;
  createdAt: string;
  expiresAt: string | null;
  rejectionReason?: string;
}

const AD_INDEX_KEY = "ads:index";
const USED_TX_HASHES_KEY = "ads:used-tx-hashes";

async function nextAdId(): Promise<string> {
  const id = await redisCommand("INCR", "ad:counter");
  return String(id);
}

async function readAd(id: string): Promise<AdSubmission | null> {
  const raw = await redisCommand("GET", `ad:${id}`);
  return typeof raw === "string" ? (JSON.parse(raw) as AdSubmission) : null;
}

async function writeAd(ad: AdSubmission): Promise<void> {
  await redisCommand("SET", `ad:${ad.id}`, JSON.stringify(ad));
  await redisCommand("ZADD", AD_INDEX_KEY, Date.parse(ad.createdAt), ad.id);
}

// Double-spend guard: one payment transaction can only ever back one ad
// submission. SADD returns 0 if the member already existed, which is the
// signal a caller needs before trusting a tx hash it hasn't seen yet.
export async function isTxHashUsed(txHash: string): Promise<boolean> {
  const members = (await redisCommand(
    "SMEMBERS",
    USED_TX_HASHES_KEY,
  )) as string[];
  return members.includes(txHash.toLowerCase());
}

async function markTxHashUsed(txHash: string): Promise<void> {
  await redisCommand("SADD", USED_TX_HASHES_KEY, txHash.toLowerCase());
}

export async function createAdSubmission(
  input: Omit<AdSubmission, "id" | "status" | "createdAt" | "expiresAt">,
): Promise<AdSubmission> {
  const id = await nextAdId();
  const ad: AdSubmission = {
    ...input,
    id,
    status: "pending_review",
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
  await writeAd(ad);
  await markTxHashUsed(input.txHash);
  return ad;
}

async function listAllAds(): Promise<AdSubmission[]> {
  const ids = (await redisCommand(
    "ZREVRANGE",
    AD_INDEX_KEY,
    0,
    -1,
  )) as string[];
  const ads = await Promise.all(ids.map((id) => readAd(id)));
  return ads.filter((ad): ad is AdSubmission => ad !== null);
}

export async function listPendingAdSubmissions(): Promise<AdSubmission[]> {
  const all = await listAllAds();
  return all.filter((ad) => ad.status === "pending_review");
}

// Active AND not yet expired - expiry is computed at read time rather than
// a separate stored transition, so nothing needs to run on a schedule to
// "expire" an ad; it just stops showing up once its own expiresAt passes.
export async function listActiveAds(): Promise<AdSubmission[]> {
  const all = await listAllAds();
  const now = Date.now();
  return all.filter(
    (ad) =>
      ad.status === "active" &&
      ad.expiresAt !== null &&
      Date.parse(ad.expiresAt) > now,
  );
}

export async function approveAdSubmission(
  id: string,
): Promise<AdSubmission | null> {
  const ad = await readAd(id);
  if (!ad) return null;
  const expiresAt = new Date(
    Date.now() + AD_SLOT_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const updated: AdSubmission = { ...ad, status: "active", expiresAt };
  await writeAd(updated);
  return updated;
}

// Re-pulls imageUrl/avatarUrl from OpenSea for an existing ad - a
// collection can update its own art after approval, and (the reason this
// was added) a handful of early submissions predate avatarUrl/imageUrl
// being resolved as two distinct fields and have avatarUrl wrongly equal
// to the wide banner image instead of the square logo.
export async function resyncAdArt(
  id: string,
): Promise<{ ok: true; ad: AdSubmission } | { ok: false; reason: string }> {
  const ad = await readAd(id);
  if (!ad) return { ok: false, reason: "Ad not found." };
  const { fetchOpenSeaCollection } = await import("@/lib/opensea");
  const result = await fetchOpenSeaCollection(ad.openseaUrl);
  if (!result.ok) return { ok: false, reason: result.reason };
  const updated: AdSubmission = {
    ...ad,
    name: result.collection.name,
    imageUrl: result.collection.imageUrl,
    avatarUrl: result.collection.avatarUrl,
  };
  await writeAd(updated);
  return { ok: true, ad: updated };
}

export async function rejectAdSubmission(
  id: string,
  reason?: string,
): Promise<AdSubmission | null> {
  const ad = await readAd(id);
  if (!ad) return null;
  const updated: AdSubmission = {
    ...ad,
    status: "rejected",
    rejectionReason: reason,
  };
  await writeAd(updated);
  return updated;
}
