// HoodchanBabies reads - genome + breeding seed for a minted offspring,
// plus standard ERC-721 ownerOf/tokenURI (shared selectors from
// lib/chain.ts). Every function name/signature below is generated from
// the real deployed ABI (lib/abi/HoodchanBabies.ts) - see BUG 4 in the
// design spec for why an earlier attempt's `genomeOf` returning
// `uint256`, plus a fabricated `parentsOf`/`seedOf` pair, never matched
// the real contract: `genomeOf` returns `uint8[5]`, there is no
// `parentsOf` (parent IDs only ever exist in the Bred event, see
// lib/breedingController.ts's parseBredEventFromLogs), and the seed
// getter is `breedingSeedOf`, not `seedOf`.
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

// genomeOf(uint256) -> uint8[5] - the 5 gene-slot values (Hat, Face, Body,
// Background, Accessory), unpacked on-chain from the contract's internal
// uint40 storage. NOT a uint256, and NOT called `genome` - matches the
// real ABI exactly.
export async function readGenomeOf(tokenId: string): Promise<number[]> {
  const contract = requireBabiesContract();
  const data = babiesInterface.encodeFunctionData("genomeOf", [tokenId]);
  const result = await ethCall(contract, data);
  const [genome] = babiesInterface.decodeFunctionResult("genomeOf", result);
  return (genome as bigint[]).map((g) => Number(g));
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
