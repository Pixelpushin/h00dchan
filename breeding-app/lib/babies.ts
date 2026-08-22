// HoodchanBabies reads - genome, sex, test-tube-baby flag, and breeding
// seed for a minted offspring, plus standard ERC-721 ownerOf/tokenURI
// (shared selectors from lib/chain.ts). Every function name/signature
// below is generated from the real deployed ABI
// (lib/abi/HoodchanBabies.ts) - see BUG 4 in the design spec for why a
// hand-written ABI is never trustworthy on its own.
//
// `genesOf` (renamed from the superseded v1 contract's `genomeOf`) is the
// same interface name every allowlisted collection speaks (see
// contracts/src/interfaces/IBreedable.sol) - a Baby needs zero
// special-casing to be used as a matron or sire in a later breed. There is
// no `parentsOf` (parent (collection,id) pairs only ever exist in the
// `Bred`/`Minted` events, see lib/breedingController.ts's
// parseBredEventFromLogs).
import { Interface } from "ethers";
import { HoodchanBabiesAbi } from "@/lib/abi/HoodchanBabies";
import { BABIES_CONTRACT } from "@/lib/config";
import { ethCall } from "@/lib/chain";

const babiesInterface = new Interface(HoodchanBabiesAbi);

export function requireBabiesContract(): string {
  if (!BABIES_CONTRACT) {
    throw new Error("HoodchanBabies is not deployed yet.");
  }
  return BABIES_CONTRACT;
}

// genesOf(uint256) -> uint8[5] - the 5 gene-slot values (Hat, Face, Body,
// Background, Accessory), unpacked on-chain from the contract's internal
// uint40 storage.
export async function readGenesOf(tokenId: string): Promise<number[]> {
  const contract = requireBabiesContract();
  const data = babiesInterface.encodeFunctionData("genesOf", [tokenId]);
  const result = await ethCall(contract, data);
  const [genes] = babiesInterface.decodeFunctionResult("genesOf", result);
  return (genes as bigint[]).map((g) => Number(g));
}

// sexOf(uint256) -> bool - true = Male, false = Female. Coin-flipped once
// at mint (GeneticsLib.resolveBabyIsMale) and fixed forever after -
// BreedingController reads this live (IPerTokenSex) whenever this baby
// later participates as a parent in its own right.
export async function readSexOf(tokenId: string): Promise<boolean> {
  const contract = requireBabiesContract();
  const data = babiesInterface.encodeFunctionData("sexOf", [tokenId]);
  const result = await ethCall(contract, data);
  const [isMale] = babiesInterface.decodeFunctionResult("sexOf", result);
  return Boolean(isMale);
}

// isTestTubeBaby(uint256) -> bool - cosmetic flex trait only:
// `matronSex == sireSex` at THIS baby's own mint time. Does not affect
// this baby's own coin-flip inheritance odds when it later breeds; purely
// a UI badge (see the design spec's "Sex tag" section).
export async function readIsTestTubeBaby(tokenId: string): Promise<boolean> {
  const contract = requireBabiesContract();
  const data = babiesInterface.encodeFunctionData("isTestTubeBaby", [tokenId]);
  const result = await ethCall(contract, data);
  const [isTestTube] = babiesInterface.decodeFunctionResult(
    "isTestTubeBaby",
    result,
  );
  return Boolean(isTestTube);
}

// breedingSeedOf(uint256) -> uint256 - the exact seed
// GeneticsLib.breedingSeed produced for this baby, stored directly on
// mint rather than only re-derivable from event logs. There is no
// `seedOf` on the real contract.
export async function readBreedingSeedOf(tokenId: string): Promise<bigint> {
  const contract = requireBabiesContract();
  const data = babiesInterface.encodeFunctionData("breedingSeedOf", [tokenId]);
  const result = await ethCall(contract, data);
  const [seed] = babiesInterface.decodeFunctionResult("breedingSeedOf", result);
  return BigInt(seed);
}

// nextTokenId() -> uint256 - the next tokenId that will be minted (also
// == 1 + total minted so far, since HoodchanBabies starts at 1 and never
// burns).
export async function readNextTokenId(): Promise<bigint> {
  const contract = requireBabiesContract();
  const data = babiesInterface.encodeFunctionData("nextTokenId", []);
  const result = await ethCall(contract, data);
  const [next] = babiesInterface.decodeFunctionResult("nextTokenId", result);
  return BigInt(next);
}

export async function readBreedingController(): Promise<string> {
  const contract = requireBabiesContract();
  const data = babiesInterface.encodeFunctionData("breedingController", []);
  const result = await ethCall(contract, data);
  const [controller] = babiesInterface.decodeFunctionResult(
    "breedingController",
    result,
  );
  return String(controller);
}
