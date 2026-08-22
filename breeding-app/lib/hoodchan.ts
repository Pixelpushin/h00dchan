// HOODCHAN (a matron/sire-eligible collection, see the design spec's
// "Collections and the breedable allowlist" section) reads - the existing,
// already-deployed contract. `isUpgraded`/STATUS:"Upgraded" gating is
// removed: it existed only to gate ETH as a second siring-fee currency
// (the v1 dual-currency ETH path), which is cut from scope entirely - CHAN
// is the ONLY fee currency now (see lib/config.ts's CHAN_TOKEN_ADDRESS
// comment).
import { HOODCHAN_CONTRACT } from "@/lib/config";
import { fetchTokenMetadata, type TokenMetadata } from "@/lib/chain";

export async function fetchHoodchanMetadata(
  tokenId: string | number,
): Promise<TokenMetadata> {
  return fetchTokenMetadata(HOODCHAN_CONTRACT, tokenId, "Anon");
}
