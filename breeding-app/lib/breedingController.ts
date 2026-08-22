// BreedingController reads/writes - siring-price listings + the two-step
// commit/reveal breeding flow (contracts/src/BreedingController.sol's
// SEED-FAIRNESS MITIGATION note explains why: a single-tx breed() would let
// a caller preview the whole genome before deciding whether to send the tx,
// since every input to the old seed was already public or readable ahead of
// time - commitBreed() escrows payment and locks both parents, then
// revealBreed() derives the seed from blockhash(commitBlock), a value that
// doesn't exist yet at commit time).
//
// Reads go through the raw JSON-RPC helpers in lib/chain.ts (parent-app
// convention: no provider SDK for reads); writes are built here as
// {to, data, value?} using ethers' `Interface` purely as a calldata encoder
// (same pattern as the parent app's lib/tba.ts) and sent through
// lib/wallet.ts's sendTransaction from the connected wallet.
//
// Every function name/signature below is generated from the real deployed
// ABI (lib/abi/BreedingController.ts, itself generated from contracts/out/
// by scripts/copy-abis.ts) - see the design spec's BUG 4 for why an earlier
// attempt's hand-written breedWithChan/breedWithEth/setSirePrice/
// allListedTokenIds() never actually existed on this contract, and BUG 2
// for why commitBreed takes explicit maxChanPrice/maxEthPrice bounds (never
// trust a live-read price with no slippage guard). There is no on-chain
// enumerator for "every listed father" - `siringListings` is a plain
// per-tokenId mapping getter, so listing discovery across many fathers is
// handled by app/api/listings/route.ts (SiringListed log replay + a live
// re-check per candidate), not this file.
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

// Mirrors the contract's `enum PayMethod { CHAN, ETH }` exactly - passed to
// commitBreed() and read back out of the Bred/CommitCreated events.
export enum PayMethod {
  CHAN = 0,
  ETH = 1,
}

export interface SiringListing {
  fatherTokenId: string;
  chanPrice: bigint;
  ethPrice: bigint;
  listed: boolean;
}

export function requireController(): string {
  if (!BREEDING_CONTROLLER_CONTRACT) {
    throw new Error("BreedingController is not deployed yet.");
  }
  return BREEDING_CONTROLLER_CONTRACT;
}

// The Bred event signature hash (topic0) - computed once from the real ABI
// (not a literal guessed constant) so BUG 5's log-forgery check
// (parseBredEventFromLogs below) verifies against the actual deployed
// event, not a hand-copied string that could silently drift from the ABI.
const BRED_EVENT_FRAGMENT = controllerInterface.getEvent("Bred");
if (!BRED_EVENT_FRAGMENT) {
  throw new Error("BreedingController ABI is missing the Bred event.");
}
export const BRED_EVENT_TOPIC0 = BRED_EVENT_FRAGMENT.topicHash;

const COMMIT_CREATED_FRAGMENT = controllerInterface.getEvent("CommitCreated");
if (!COMMIT_CREATED_FRAGMENT) {
  throw new Error("BreedingController ABI is missing the CommitCreated event.");
}
export const COMMIT_CREATED_EVENT_TOPIC0 = COMMIT_CREATED_FRAGMENT.topicHash;

// siringListings(uint256) -> (uint128 chanPrice, uint128 ethPrice, bool
// listed) - the public mapping getter Solidity auto-generates for
// `mapping(uint256 => SiringListing) public siringListings`. There is no
// separate `listingOf`/enumerator function on the real contract.
export async function readSiringListing(
  fatherTokenId: string,
): Promise<SiringListing> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("siringListings", [
    fatherTokenId,
  ]);
  const result = await ethCall(contract, data);
  const [chanPrice, ethPrice, listed] =
    controllerInterface.decodeFunctionResult("siringListings", result);
  return {
    fatherTokenId,
    chanPrice: BigInt(chanPrice),
    ethPrice: BigInt(ethPrice),
    listed: Boolean(listed),
  };
}

export async function readHoodchanGenesSet(
  fatherTokenId: string,
): Promise<boolean> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("hoodchanGenesSet", [
    fatherTokenId,
  ]);
  const result = await ethCall(contract, data);
  const [set] = controllerInterface.decodeFunctionResult(
    "hoodchanGenesSet",
    result,
  );
  return Boolean(set);
}

export async function readUpgradedAllowlist(
  fatherTokenId: string,
): Promise<boolean> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("upgradedAllowlist", [
    fatherTokenId,
  ]);
  const result = await ethCall(contract, data);
  const [allowed] = controllerInterface.decodeFunctionResult(
    "upgradedAllowlist",
    result,
  );
  return Boolean(allowed);
}

export async function readHoodchanGenes(
  fatherTokenId: string,
): Promise<number[]> {
  const contract = requireController();
  const genes = await Promise.all(
    [0, 1, 2, 3, 4].map(async (slotIndex) => {
      const data = controllerInterface.encodeFunctionData("hoodchanGenes", [
        fatherTokenId,
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

export async function readFatherLocked(
  fatherTokenId: string,
): Promise<boolean> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("fatherLocked", [
    fatherTokenId,
  ]);
  const result = await ethCall(contract, data);
  const [locked] = controllerInterface.decodeFunctionResult(
    "fatherLocked",
    result,
  );
  return Boolean(locked);
}

export async function readMotherLocked(
  motherTokenId: string,
): Promise<boolean> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("motherLocked", [
    motherTokenId,
  ]);
  const result = await ethCall(contract, data);
  const [locked] = controllerInterface.decodeFunctionResult(
    "motherLocked",
    result,
  );
  return Boolean(locked);
}

// setSiringPrice(uint256,uint128,uint128) - only the current HOODCHAN
// owner may call this (checked on-chain, not here). NOT `setSirePrice` -
// see this file's header comment.
export function buildSetSiringPriceTx(
  fatherTokenId: string,
  chanPrice: bigint,
  ethPrice: bigint,
): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("setSiringPrice", [
      fatherTokenId,
      chanPrice,
      ethPrice,
    ]),
  };
}

export function buildDelistSiringTx(fatherTokenId: string): {
  to: string;
  data: string;
} {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("delistSiring", [
      fatherTokenId,
    ]),
  };
}

// commitBreed(fatherTokenId, motherTokenId, maxChanPrice, maxEthPrice,
// method) -> commitId. Step 1 of 2 - see this file's header. `maxChanPrice`/
// `maxEthPrice` MUST be the exact price the caller saw and approved right
// before sending this tx (BUG 2's slippage guard): the contract escrows
// whatever the CURRENT listed price is at commit time, but reverts with
// PriceExceedsMax if that price is higher than the bound passed here, so a
// father owner front-running with setSiringPrice can raise the caller's
// cost above what they agreed to instead of silently draining more.
// Callers not paying (same-owner breed, or a free 0-price listing) should
// still pass the current price as the max (0 if free) rather than
// type(uint128).max - passing an unbounded max defeats the whole guard.
export function buildCommitBreedTx(
  fatherTokenId: string,
  motherTokenId: string,
  maxChanPrice: bigint,
  maxEthPrice: bigint,
  method: PayMethod,
  valueWei: bigint = BigInt(0),
): { to: string; data: string; value?: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("commitBreed", [
      fatherTokenId,
      motherTokenId,
      maxChanPrice,
      maxEthPrice,
      method,
    ]),
    value: method === PayMethod.ETH ? valueWei.toString() : undefined,
  };
}

// revealBreed(commitId) -> babyTokenId. Step 2 of 2, callable by ANYONE
// once block.number > commitBlock (not restricted to the original
// committer - see the contract's own doc comment). The UI should
// auto-call this once eligible (~1 block after commitBreed lands) rather
// than requiring a second manual click.
export function buildRevealBreedTx(commitId: string): {
  to: string;
  data: string;
} {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("revealBreed", [commitId]),
  };
}

// cancelExpiredCommit(commitId) - refunds the escrowed payment and unlocks
// both parent tokens for a commit whose 256-block blockhash reveal window
// has closed without a reveal (an "abandoned" commit). Callable by anyone,
// same rationale as revealBreed.
export function buildCancelExpiredCommitTx(commitId: string): {
  to: string;
  data: string;
} {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("cancelExpiredCommit", [
      commitId,
    ]),
  };
}

export function buildClaimEthTx(): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("claimEth", []),
  };
}

export function buildClaimChanTx(): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("claimChan", []),
  };
}

// --- Operator-only metadata-sync writes (scripts/sync-genes.ts) ---------
//
// setHoodchanGenes(Batch)/setUpgradedAllowlist(Batch) are the two
// operator-gated entry points that make HOODCHAN fathers usable for
// breeding at all - see BreedingController.sol's "DISCOVERY-DRIVEN
// DESIGN" note: HOODCHAN's real traits live in off-chain IPFS/HTTP
// metadata this contract cannot eth_call into, so an operator (the
// off-chain sync script) has to push them in. `breed()`/`commitBreed()`
// revert GenesNotSet for any father whose genes were never synced this
// way - these two builders are what unblocks that.
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

export function buildSetUpgradedAllowlistBatchTx(
  tokenIds: Array<string | number>,
  allowed: boolean,
): { to: string; data: string } {
  return {
    to: requireController(),
    data: controllerInterface.encodeFunctionData("setUpgradedAllowlistBatch", [
      tokenIds.map((id) => id.toString()),
      allowed,
    ]),
  };
}

export interface CommitInfo {
  commitId: string;
  fatherTokenId: string;
  motherTokenId: string;
  committer: string;
  fatherOwnerAtCommit: string;
  commitBlock: bigint;
  nonce: bigint;
  amountEscrowed: bigint;
  method: PayMethod;
  sameOwner: boolean;
  resolved: boolean;
}

// commits(uint256) -> the full Commit struct - used to drive the UI's
// "resume an abandoned commit" path (poll commitBlock/resolved to decide
// whether to show a Reveal or Cancel button for a commitId the user has,
// e.g. from localStorage or a prior tx that never got revealed client-side).
export async function readCommit(commitId: string): Promise<CommitInfo> {
  const contract = requireController();
  const data = controllerInterface.encodeFunctionData("commits", [commitId]);
  const result = await ethCall(contract, data);
  const [
    fatherTokenId,
    motherTokenId,
    committer,
    fatherOwnerAtCommit,
    commitBlock,
    nonce,
    amountEscrowed,
    method,
    sameOwner,
    resolved,
  ] = controllerInterface.decodeFunctionResult("commits", result);
  return {
    commitId,
    fatherTokenId: fatherTokenId.toString(),
    motherTokenId: motherTokenId.toString(),
    committer: String(committer),
    fatherOwnerAtCommit: String(fatherOwnerAtCommit),
    commitBlock: BigInt(commitBlock),
    nonce: BigInt(nonce),
    amountEscrowed: BigInt(amountEscrowed),
    method: Number(method) as PayMethod,
    sameOwner: Boolean(sameOwner),
    resolved: Boolean(resolved),
  };
}

export interface BredEventResult {
  babyTokenId: string;
  fatherTokenId: string;
  motherTokenId: string;
  breedNonce: bigint;
  seed: bigint;
  genome: number[];
  motherTba: string;
  paymentMethod: PayMethod;
  amountPaid: bigint;
  commitId: string;
}

// Parses the Bred event out of a transaction receipt's logs - used by
// app/api/breed/[txHash]/route.ts to learn the freshly-minted baby's ID,
// seed, genome, and mother's TBA without polling a separate indexer.
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
          fatherTokenId: args.fatherTokenId.toString(),
          motherTokenId: args.motherTokenId.toString(),
          breedNonce: BigInt(args.breedNonce_),
          seed: BigInt(args.seed),
          genome: (args.genome as bigint[]).map((g) => Number(g)),
          motherTba: String(args.motherTba),
          paymentMethod: Number(args.paymentMethod) as PayMethod,
          amountPaid: BigInt(args.amountPaid),
          commitId: args.commitId.toString(),
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
// to this exact babyTokenId (topic1, indexed) AND the real controller
// address + Bred topic0 (same BUG 5(a) verification as
// parseBredEventFromLogs above - a log matching only babyTokenId but from
// the wrong contract must never be trusted). fatherTokenId/motherTokenId
// come straight off topics[2]/topics[3] (both indexed) rather than the ABI
// decoder, since indexed uint256 topics don't need full log decoding to
// read.
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
