// BreedingController reads/writes - siring listings + the single
// atomic-transaction breed() flow (contracts/src/BreedingController.sol's
// ACCEPTED TRADEOFF note explains why a single-tx breed() is fine here,
// not a bug: the design spec explicitly accepts a predictable/simulable
// seed - "you get what you get" - in exchange for deleting the superseded
// v1 commit/reveal escrow/lock/expiry machinery entirely. There is no
// commitBreed()/revealBreed() two-step anymore.
//
// Reads go through the raw JSON-RPC helpers in lib/chain.ts (parent-app
// convention: no provider SDK for reads); writes are built here as
// {to, data, value?} using ethers' `Interface` purely as a calldata encoder
// (same pattern as the parent app's lib/tba.ts) and sent through
// lib/wallet.ts's sendTransaction from the connected wallet.
//
// Every function name/signature below is generated from the real deployed
// ABI (lib/abi/BreedingController.ts, itself generated from contracts/out/
// by scripts/copy-abis.ts) - see the design spec's BUG 4 for why an
// earlier attempt's hand-written ABI (breedWithChan/breedWithEth,
// setSirePrice, allListedTokenIds()...) never actually existed on this
// contract. There is no on-chain enumerator for "every listed sire" -
// `siringListings` is a plain per-(collection,tokenId) mapping getter, so
// listing discovery across many sires is handled by
// app/api/listings/route.ts (SiringListed log replay + a live re-check per
// candidate), not this file.
import { Interface } from "ethers";
import { BreedingControllerAbi } from "@/lib/abi/BreedingController";
import { BREEDING_CONTROLLER_CONTRACT } from "@/lib/config";
import { ethCall, rpcCall } from "@/lib/chain";

const controllerInterface = new Interface(BreedingControllerAbi);

// Raw eth_getTransactionReceipt/eth_getLogs log shape - deliberately not
// ethers' own `Log` class (which requires a live provider to construct),
// since this is fed plain JSON-RPC log objects from lib/chain.ts's rpcCall.
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string;
  logIndex?: string;
  transactionHash?: string;
}

// Mirrors the contract's `enum CollectionSex { Male, Female, PerToken }`
// exactly - Male/Female are fixed per-collection at allowlist time
// (HOODCHAN/Girlfriends); PerToken defers to the token's own contract
// (currently only HoodchanBabies, via IPerTokenSex.sexOf).
export enum CollectionSex {
  Male = 0,
  Female = 1,
  PerToken = 2,
}

export interface SiringListing {
  collection: string;
  tokenId: string;
  price: bigint;
  listed: boolean;
  lister: string;
}

export interface TokenBreedState {
  collection: string;
  tokenId: string;
  breedCount: number;
  cooldownEnd: bigint;
}

export function requireController(): string {
  if (!BREEDING_CONTROLLER_CONTRACT) {
    throw new Error("BreedingController is not deployed yet.");
  }
  return BREEDING_CONTROLLER_CONTRACT;
}

// The Bred event signature hash (topic0) - computed once from the real ABI
// (not a literal guessed constant) so BUG 5(a)'s log-forgery check
// (parseBredEventFromLogs below) verifies against the actual deployed
// event, not a hand-copied string that could silently drift from the ABI.
const BRED_EVENT_FRAGMENT = controllerInterface.getEvent("Bred");
if (!BRED_EVENT_FRAGMENT) {
  throw new Error("BreedingController ABI is missing the Bred event.");
}
export const BRED_EVENT_TOPIC0 = BRED_EVENT_FRAGMENT.topicHash;

// ---------------------------------------------------------------------------
// Reads: allowlist / collection config
// ---------------------------------------------------------------------------

export async function readIsBreedableCollection(
  collection: string,
): Promise<boolean> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("isBreedableCollection", [
    collection,
  ]);
  const result = await ethCall(contract, data);
  const [allowed] = controllerInterface.decodeFunctionResult(
    "isBreedableCollection",
    result,
  );
  return Boolean(allowed);
}

export async function readCollectionSex(
  collection: string,
): Promise<CollectionSex> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("collectionSex", [
    collection,
  ]);
  const result = await ethCall(contract, data);
  const [sex] = controllerInterface.decodeFunctionResult(
    "collectionSex",
    result,
  );
  return Number(sex) as CollectionSex;
}

// ---------------------------------------------------------------------------
// Reads: fee config (see lib/config.ts's DEFAULT_BIRTH_FEE /
// DEFAULT_SAME_SEX_FEE_MULTIPLIER for the pre-deploy-preview mirrors of
// these same values - once BreedingController is deployed, these live
// reads are the actual source of truth, owner-configurable post-deploy).
// ---------------------------------------------------------------------------

export async function readBirthFee(): Promise<bigint> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("birthFee", []);
  const result = await ethCall(contract, data);
  const [fee] = controllerInterface.decodeFunctionResult("birthFee", result);
  return BigInt(fee);
}

export async function readSameSexFeeMultiplier(): Promise<bigint> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData(
    "sameSexFeeMultiplier",
    [],
  );
  const result = await ethCall(contract, data);
  const [multiplier] = controllerInterface.decodeFunctionResult(
    "sameSexFeeMultiplier",
    result,
  );
  return BigInt(multiplier);
}

export async function readTreasury(): Promise<string> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("treasury", []);
  const result = await ethCall(contract, data);
  const [treasury] = controllerInterface.decodeFunctionResult(
    "treasury",
    result,
  );
  return String(treasury);
}

export async function readBurnAddress(): Promise<string> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("burnAddress", []);
  const result = await ethCall(contract, data);
  const [addr] = controllerInterface.decodeFunctionResult(
    "burnAddress",
    result,
  );
  return String(addr);
}

export async function readMultisigAddress(): Promise<string> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("multisig", []);
  const result = await ethCall(contract, data);
  const [addr] = controllerInterface.decodeFunctionResult("multisig", result);
  return String(addr);
}

// ---------------------------------------------------------------------------
// Reads: escalating cooldown state + siring listings - both COMPOSITE
// (collection, tokenId) keyed, matching BreedingController's `breedState`/
// `siringListings` mappings exactly (see that contract's comment on why:
// e.g. HOODCHAN #5 and Babies #5 must never share cooldown state just
// because their tokenIds collide across different collections).
// ---------------------------------------------------------------------------

export async function readBreedState(
  collection: string,
  tokenId: string,
): Promise<TokenBreedState> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("breedState", [
    collection,
    tokenId,
  ]);
  const result = await ethCall(contract, data);
  const [breedCount, cooldownEnd] = controllerInterface.decodeFunctionResult(
    "breedState",
    result,
  );
  return {
    collection,
    tokenId,
    breedCount: Number(breedCount),
    cooldownEnd: BigInt(cooldownEnd),
  };
}

export async function readSiringListing(
  collection: string,
  tokenId: string,
): Promise<SiringListing> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("siringListings", [
    collection,
    tokenId,
  ]);
  const result = await ethCall(contract, data);
  const [price, listed, lister] = controllerInterface.decodeFunctionResult(
    "siringListings",
    result,
  );
  return {
    collection,
    tokenId,
    price: BigInt(price),
    listed: Boolean(listed),
    lister: String(lister),
  };
}

// ---------------------------------------------------------------------------
// Reads: HOODCHAN gene-sync trust point (see BreedingController.sol's
// HOODCHAN ADAPTER note - HOODCHAN's genes are synced in, not read live).
// ---------------------------------------------------------------------------

export async function readHoodchanGenesSet(tokenId: string): Promise<boolean> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("hoodchanGenesSet", [
    tokenId,
  ]);
  const result = await ethCall(contract, data);
  const [set] = controllerInterface.decodeFunctionResult(
    "hoodchanGenesSet",
    result,
  );
  return Boolean(set);
}

export async function readHoodchanGenes(tokenId: string): Promise<number[]> {
  const contract = requireController();
  const genes = await Promise.all(
    [0, 1, 2, 3, 4].map(async (slotIndex) => {
      const data = controllerInterface.encodeFunctionData("hoodchanGenes", [
        tokenId,
        slotIndex,
      ]);
      const result = await ethCall(contract, data);
      const [value] = controllerInterface.decodeFunctionResult(
        "hoodchanGenes",
        result,
      );
      return Number(value);
    }),
  );
  return genes;
}

// ---------------------------------------------------------------------------
// Writes: siring listings - generalized to any allowlisted (collection,
// tokenId), not just HOODCHAN. Gated on the CURRENT ownerOf at call time
// on-chain (not here) - see BreedingController.listSiring/unlistSiring's
// own doc comments for the stale-listing-on-transfer fix (BUG 2 from
// adversarial review).
// ---------------------------------------------------------------------------

export function buildListSiringTx(
  collection: string,
  tokenId: string,
  price: bigint,
): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("listSiring", [
      collection,
      tokenId,
      price,
    ]),
  };
}

export function buildUnlistSiringTx(
  collection: string,
  tokenId: string,
): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("unlistSiring", [
      collection,
      tokenId,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Write: breed() - the single atomic entry point. Every field of the two
// parents is now a (collection, id) PAIR, not a bare tokenId, since any of
// the three allowlisted collections can fill either role (see the design
// spec's "Collections and the breedable allowlist" section).
//
// `maxSiringFee` is REQUIRED, not optional - see
// BreedingController.breed()'s own doc comment on why: the sire's owner is
// an UNTRUSTED counterparty who can re-call `listSiring` at any moment,
// including in the block that front-runs this call. Every call site MUST
// pass the caller's own last-seen quote (the sire's current
// `siringListings(...).price`, or 0 for self-siring/caller-owned sires),
// NEVER `type(uint256).max` - passing an unbounded max defeats the whole
// slippage guard and reopens the exact fund-loss bug adversarial review
// found in the superseded v1 attempt.
// ---------------------------------------------------------------------------

export function buildBreedTx(
  matronCollection: string,
  matronId: string,
  sireCollection: string,
  sireId: string,
  maxSiringFee: bigint,
): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("breed", [
      matronCollection,
      matronId,
      sireCollection,
      sireId,
      maxSiringFee,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Fee preview - computes the caller's EXACT total CHAN debit for a
// prospective breed, mirroring BreedingController._collectBirthFee /
// _collectSiringFee's arithmetic bit-for-bit (independent floor division
// per protocol-fee component, not a single combined-bps multiply - see
// that contract's doc comment on why the two differ by up to 1 wei).
// Verified against the forge-generated fee vectors in
// lib/breedingController.test.ts (contracts/test-vectors*.json's "fees"
// section) - this is the one place in the app that must match the
// contract's fee math exactly, since it's what a UI shows the user BEFORE
// they sign, and what `maxSiringFee` above should be derived from.
// ---------------------------------------------------------------------------

export interface BreedFeePreviewInput {
  birthFee: bigint;
  sameSexFeeMultiplier: bigint;
  matronSex: boolean;
  sireSex: boolean;
  /** Caller owns/is-approved-for the sire directly - if true, no siring
   * fee (and therefore no protocol fee) applies at all, regardless of
   * `listedPrice` (self-siring is always free of the siring-fee leg). */
  sireCallerOwned: boolean;
  /** The sire's CURRENT `siringListings(...).price` - ignored when
   * `sireCallerOwned` is true. This is also the value that should be
   * passed as `buildBreedTx`'s `maxSiringFee` argument. */
  listedPrice: bigint;
}

export interface BreedFeePreview {
  birthFeePaid: bigint;
  sireOwnerAmount: bigint;
  burnAmount: bigint;
  multisigAmount: bigint;
  totalCallerDebit: bigint;
}

export function previewBreedFee(input: BreedFeePreviewInput): BreedFeePreview {
  const sameSex = input.matronSex === input.sireSex;
  const birthFeePaid = sameSex
    ? input.birthFee * input.sameSexFeeMultiplier
    : input.birthFee;

  const payingSiringFee = !input.sireCallerOwned;
  const sireOwnerAmount = payingSiringFee ? input.listedPrice : 0n;
  // Independent floor division per component - matches
  // BreedingController._collectSiringFee exactly, NOT
  // `listedPrice * 800n / 10000n` computed once.
  const burnAmount = payingSiringFee ? (input.listedPrice * 500n) / 10000n : 0n;
  const multisigAmount = payingSiringFee
    ? (input.listedPrice * 300n) / 10000n
    : 0n;

  return {
    birthFeePaid,
    sireOwnerAmount,
    burnAmount,
    multisigAmount,
    totalCallerDebit:
      birthFeePaid + sireOwnerAmount + burnAmount + multisigAmount,
  };
}

// ---------------------------------------------------------------------------
// Operator-only metadata-sync write (scripts/sync-genes.ts) - the one
// operator-gated entry point that makes HOODCHAN parents usable for
// breeding at all (see BreedingController.sol's HOODCHAN ADAPTER note):
// HOODCHAN's real traits live in off-chain IPFS/HTTP metadata this
// contract cannot eth_call into, so an operator (the off-chain sync
// script) has to push them in. `breed()` reverts GenesNotSet for any
// HOODCHAN parent whose genes were never synced this way.
// ---------------------------------------------------------------------------

export function buildSetHoodchanGenesBatchTx(
  tokenIds: Array<string | number>,
  genes: Array<[number, number, number, number, number]>,
): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("setHoodchanGenesBatch", [
      tokenIds.map((id) => id.toString()),
      genes,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Bred event parsing
// ---------------------------------------------------------------------------

export interface BredEventResult {
  babyTokenId: string;
  matronCollection: string;
  matronId: string;
  sireCollection: string;
  sireId: string;
  breedNonce: bigint;
  seed: bigint;
  genome: number[];
  babyIsMale: boolean;
  isTestTubeBaby: boolean;
}

// Parses the Bred event out of a transaction receipt's logs - used by
// app/api/breed/[txHash]/route.ts to learn the freshly-minted baby's ID,
// seed, genome, sex, and test-tube-baby flag without polling a separate
// indexer.
//
// BUG 5(a) fix: a log is ONLY accepted as a real Bred event if BOTH (1)
// `log.address` case-insensitively equals the configured
// BreedingController address, AND (2) `log.topics[0]` equals this ABI's
// real Bred event signature hash (BRED_EVENT_TOPIC0, computed from the
// deployed ABI, not a guessed literal). Without the address check, any
// contract could emit a same-shaped event (same topic0, attacker-chosen
// data) and this function would have parsed it as if BreedingController
// itself emitted it - see lib/breedingController.test.ts for a test
// proving a same-shaped log from a different address is rejected.
export function parseBredEventFromLogs(
  logs: RawLog[],
  controllerAddress: string,
): BredEventResult | null {
  const controllerLower = controllerAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== controllerLower) continue;
    if (log.topics[0]?.toLowerCase() !== BRED_EVENT_TOPIC0.toLowerCase()) {
      continue;
    }
    try {
      const parsed = controllerInterface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (parsed?.name === "Bred") {
        const args = parsed.args;
        return {
          babyTokenId: args.babyTokenId.toString(),
          matronCollection: String(args.matronCollection),
          matronId: args.matronId.toString(),
          sireCollection: String(args.sireCollection),
          sireId: args.sireId.toString(),
          breedNonce: BigInt(args.breedNonce_),
          seed: BigInt(args.seed),
          genome: (args.genome as bigint[]).map((g) => Number(g)),
          babyIsMale: Boolean(args.babyIsMale),
          isTestTubeBaby: Boolean(args.isTestTubeBaby),
        };
      }
    } catch {
      // Address+topic0 matched but decoding still failed (shouldn't
      // happen for a real controller-emitted log) - treat as not found
      // rather than throwing, same as the original scan-and-skip shape.
    }
  }
  return null;
}

// Historical lookup for app/baby/[tokenId]/page.tsx - a fresh page load
// (not right after breeding) has no receipt to read logs from, so this
// replays the Bred event log directly off-chain via eth_getLogs, filtered
// to this exact babyTokenId (topic1, the only indexed field on the new
// event) AND the real controller address + Bred topic0 (same BUG 5(a)
// verification as parseBredEventFromLogs above - a log matching only
// babyTokenId but from the wrong contract must never be trusted).
export async function readBredEventForBaby(
  babyTokenId: string,
): Promise<BredEventResult | null> {
  const contract = requireController();
  const topicForBaby = `0x${BigInt(babyTokenId).toString(16).padStart(64, "0")}`;
  const logs = await rpcCall<RawLog[]>("eth_getLogs", [
    {
      address: contract,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [BRED_EVENT_TOPIC0, topicForBaby],
    },
  ]);
  // Even though the query already filtered by address, re-verify through
  // the same parseBredEventFromLogs path used for tx-receipt logs, so
  // there is exactly one code path that decides "is this a real Bred
  // event" anywhere in this app.
  return parseBredEventFromLogs(logs, contract);
}
