// Girlfriends collection helpers - wallet enumeration (Transfer-log scan,
// same as HOODCHAN itself - no ERC721Enumerable assumed) plus TBA + nested
// offspring lookups for app/my/page.tsx ("her own token-bound wallet,
// enumerate Babies owned by that TBA").
import {
  GIRLFRIENDS_CONTRACT,
  BABIES_CONTRACT,
  MAX_NESTED_OFFSPRING,
} from "@/lib/config";
import { fetchWalletTokensOnChain } from "@/lib/chain";
import { computeTbaAddress } from "@/lib/tba";

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
