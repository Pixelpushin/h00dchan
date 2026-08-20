// CircleJerkFinance registry storage - community-submitted NFT
// collections/tokens, listed so other community projects can query
// lib/registryEligibility.ts's live-holdings check for automated mutual
// whitelisting. Same shape as lib/adStore.ts's thread/post-style pattern
// (registry:counter INCR, registry:<id> JSON blob, registry:index ZSET for
// ordered listing), reusing lib/store.ts's redisCommand rather than a
// second Redis client.
import { redisCommand } from "@/lib/store";

export type RegistryKind = "nft" | "token";

export interface RegistryEntry {
  id: string;
  kind: RegistryKind;
  name: string;
  contractAddress: string; // always lowercase
  url: string;
  description: string;
  submitterTokenId: string;
  submitterAddress: string;
  // True if this entry only exists because a core member's own signature
  // vouched for it (lib/registryEligibility.ts's sponsor path) - the
  // submitting token itself didn't clear the normal nested+post bar.
  sponsored: boolean;
  createdAt: string;
}

const REGISTRY_INDEX_KEY = "registry:index";
const REGISTRY_ADDRESSES_KEY = "registry:addresses";

async function nextRegistryId(): Promise<string> {
  const id = await redisCommand("INCR", "registry:counter");
  return String(id);
}

async function readEntry(id: string): Promise<RegistryEntry | null> {
  const raw = await redisCommand("GET", `registry:${id}`);
  return typeof raw === "string" ? (JSON.parse(raw) as RegistryEntry) : null;
}

async function writeEntry(entry: RegistryEntry): Promise<void> {
  await redisCommand("SET", `registry:${entry.id}`, JSON.stringify(entry));
  await redisCommand(
    "ZADD",
    REGISTRY_INDEX_KEY,
    Date.parse(entry.createdAt),
    entry.id,
  );
}

// Dedup guard: one contract address can only ever have one live registry
// entry - without this, the same project could be spammed in repeatedly
// (or two different submitters could both list it, muddying "who vouched
// for this"). Checked/set the same SADD-returns-0-if-present way as
// lib/adStore.ts's isTxHashUsed/markTxHashUsed double-spend guard.
export async function isContractRegistered(
  contractAddress: string,
): Promise<boolean> {
  const members = (await redisCommand(
    "SMEMBERS",
    REGISTRY_ADDRESSES_KEY,
  )) as string[];
  return members.includes(contractAddress.toLowerCase());
}

async function markContractRegistered(
  contractAddress: string,
): Promise<boolean> {
  const added = await redisCommand(
    "SADD",
    REGISTRY_ADDRESSES_KEY,
    contractAddress.toLowerCase(),
  );
  return added === 1;
}

async function unmarkContractRegistered(
  contractAddress: string,
): Promise<void> {
  await redisCommand(
    "SREM",
    REGISTRY_ADDRESSES_KEY,
    contractAddress.toLowerCase(),
  );
}

export async function createRegistryEntry(
  input: Omit<RegistryEntry, "id" | "createdAt">,
): Promise<{ ok: true; entry: RegistryEntry } | { ok: false; reason: string }> {
  const claimed = await markContractRegistered(input.contractAddress);
  if (!claimed) {
    return { ok: false, reason: "This contract is already registered." };
  }
  try {
    const id = await nextRegistryId();
    const entry: RegistryEntry = {
      ...input,
      id,
      createdAt: new Date().toISOString(),
    };
    await writeEntry(entry);
    return { ok: true, entry };
  } catch (err) {
    // Same compensating-action reasoning as lib/adStore.ts's
    // unmarkTxHashUsed - only reached if the write itself failed right
    // after we won the dedup claim, so the contract address doesn't stay
    // permanently burned with no entry ever created.
    await unmarkContractRegistered(input.contractAddress);
    throw err;
  }
}

export async function listRegistryEntries(): Promise<RegistryEntry[]> {
  const ids = (await redisCommand(
    "ZREVRANGE",
    REGISTRY_INDEX_KEY,
    0,
    -1,
  )) as string[];
  const entries = await Promise.all(ids.map((id) => readEntry(id)));
  return entries.filter((entry): entry is RegistryEntry => entry !== null);
}

export async function removeRegistryEntry(id: string): Promise<boolean> {
  const entry = await readEntry(id);
  if (!entry) return false;
  await redisCommand("DEL", `registry:${id}`);
  await redisCommand("ZREM", REGISTRY_INDEX_KEY, id);
  await unmarkContractRegistered(entry.contractAddress);
  return true;
}
