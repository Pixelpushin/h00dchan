// Girlfriends collection helpers - wallet enumeration (Transfer-log scan,
// same as HOODCHAN itself - no ERC721Enumerable assumed) plus TBA + nested
// offspring lookups for app/my/page.tsx ("her own token-bound wallet,
// enumerate Babies owned by that TBA").
import { Interface } from "ethers";
import { HoodchanGirlfriendsAbi } from "@/lib/abi/HoodchanGirlfriends";
import {
  GIRLFRIENDS_CONTRACT,
  BABIES_CONTRACT,
  MAX_NESTED_OFFSPRING,
} from "@/lib/config";
import { fetchWalletTokensOnChain, ethCall } from "@/lib/chain";
import { computeTbaAddress } from "@/lib/tba";

const girlfriendsInterface = new Interface(HoodchanGirlfriendsAbi);

export function requireGirlfriendsContract(): string {
  if (!GIRLFRIENDS_CONTRACT) {
    throw new Error("HOODCHAN_GIRLFRIENDS is not deployed yet.");
  }
  return GIRLFRIENDS_CONTRACT;
}

export async function fetchOwnedGirlfriendIds(
  address: string,
): Promise<string[]> {
  return fetchWalletTokensOnChain(requireGirlfriendsContract(), address);
}

// genesOf(uint256) -> uint8[5] - the mother's on-chain gene array, stored
// directly at mint time (contracts/src/HoodchanGirlfriends.sol - unlike
// HOODCHAN's own genes, there is no off-chain sync trust point for the
// mother's side of a breed). Used both by the breed page's local genome
// preview/verification and by app/baby/[tokenId]/page.tsx's recompute
// check.
export async function readGirlfriendGenesOf(
  tokenId: string,
): Promise<number[]> {
  const contract = requireGirlfriendsContract();
  const data = girlfriendsInterface.encodeFunctionData("genesOf", [tokenId]);
  const result = await ethCall(contract, data);
  const [genes] = girlfriendsInterface.decodeFunctionResult("genesOf", result);
  return (genes as bigint[]).map((g) => Number(g));
}

export interface GirlfriendWithNested {
  tokenId: string;
  tbaAddress: string;
  nestedBabyIds: string[];
  atCap: boolean;
}

// For each owned Girlfriend, computes her TBA and enumerates any Babies
// currently nested inside it (Transfer-log scan against the Babies
// contract, owner = the mother's TBA address) - mirrors the parent app's
// nested-holding pattern exactly (lib/collectionSnapshot.ts's
// nestedHoldingCount), just reused for a different pair of contracts.
export async function fetchGirlfriendsWithNestedBabies(
  address: string,
): Promise<GirlfriendWithNested[]> {
  const girlfriendIds = await fetchOwnedGirlfriendIds(address);
  const babiesContract = BABIES_CONTRACT;
  if (!babiesContract) {
    return girlfriendIds.map((tokenId) => ({
      tokenId,
      tbaAddress: "",
      nestedBabyIds: [],
      atCap: false,
    }));
  }
  return Promise.all(
    girlfriendIds.map(async (tokenId) => {
      const tbaAddress = await computeTbaAddress(
        requireGirlfriendsContract(),
        tokenId,
      );
      const nestedBabyIds = await fetchWalletTokensOnChain(
        babiesContract,
        tbaAddress,
      );
      return {
        tokenId,
        tbaAddress,
        nestedBabyIds,
        atCap: nestedBabyIds.length >= MAX_NESTED_OFFSPRING,
      };
    }),
  );
}
