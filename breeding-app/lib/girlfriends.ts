// Girlfriends collection helpers - wallet enumeration (Transfer-log scan,
// same as HOODCHAN itself - no ERC721Enumerable assumed) plus a purely
// informational nested-offspring lookup for app/my/page.tsx ("her own
// token-bound wallet, list any Babies someone voluntarily nested inside
// it"). Nesting is no longer part of the breed flow at all (see the design
// spec's "Explicitly cut from scope": babies always mint straight to the
// matron's OWNER wallet now, never into a TBA) - a Girlfriend's TBA is
// just an optional destination an owner can voluntarily move an
// already-minted baby into afterward, for the parent app's existing
// lib/leveling.ts XP. There is no cap on this anymore (the v1 NESTED_CAP/
// MAX_NESTED_OFFSPRING gating mechanic is dead, not just moved) - display
// only, never a gate on anything breeding-related.
import { Interface } from "ethers";
import { HoodchanGirlfriendsAbi } from "@/lib/abi/HoodchanGirlfriends";
import { GIRLFRIENDS_CONTRACT, BABIES_CONTRACT } from "@/lib/config";
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
}

// For each owned Girlfriend, computes her TBA and enumerates any Babies
// currently nested inside it (Transfer-log scan against the Babies
// contract, owner = the mother's TBA address) - purely informational (see
// this file's header): nesting is a voluntary post-breed action an owner
// can take, not a breeding-flow gate, so there is no cap/atCap field here
// anymore.
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
      };
    }),
  );
}
