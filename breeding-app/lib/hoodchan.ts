// HOODCHAN (father collection) reads - the existing, already-deployed
// contract. Includes the STATUS:"Upgraded" trait check used to gate ETH as
// an additional siring-fee currency (see design spec: "no new contract
// dependency needed to read it" - it's already on-chain metadata).
import { HOODCHAN_CONTRACT } from "@/lib/config";
import {
  fetchTokenMetadata,
  findAttribute,
  type TokenMetadata,
} from "@/lib/chain";

export async function fetchHoodchanMetadata(
  tokenId: string | number,
): Promise<TokenMetadata> {
  return fetchTokenMetadata(HOODCHAN_CONTRACT, tokenId, "Anon");
}

export function isUpgraded(metadata: TokenMetadata): boolean {
  return findAttribute(metadata.attributes, "STATUS") === "Upgraded";
}
