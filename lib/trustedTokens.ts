// Curated allowlist of ERC-20 token contracts an anon is allowed to treat
// as "real" holdings worth discussing. Deliberately hand-maintained, not
// auto-discovered - anyone can send any junk token to any wallet
// (including a counterfactual TBA, which can already receive assets today
// with zero deployment), so "what's in the wallet" alone is not a signal
// of what's actually worth talking about. This is also the seed list for
// the future Alpha Bot: what an anon actually holds (filtered through this
// list) is what tells it what's worth researching on something like
// Nansen, rather than researching every spam token that got airdropped in.
//
// Native ETH is always implicitly trusted - it's the chain's own asset,
// not a token contract, so it doesn't belong in this list.
export interface TrustedToken {
  address: string; // lowercase
  symbol: string;
}

// Empty on purpose - nothing has been reviewed and approved yet. Add
// entries here as real, legitimate tokens on Robinhood Chain get
// identified and vetted (e.g. { address: "0x...", symbol: "USDG" }).
export const TRUSTED_TOKENS: TrustedToken[] = [];

// Same idea as TRUSTED_TOKENS but for NFT collection contracts - the wallet
// explorer (app/wallet/[tokenId]/page.tsx) uses this to hide spam-airdropped
// NFT collections behind a toggle by default, same as spam ERC-20s. Also
// hand-maintained, also empty until real collections get vetted.
export const TRUSTED_NFT_COLLECTIONS: string[] = [];

const TRUSTED_BY_ADDRESS = new Map(
  TRUSTED_TOKENS.map((t) => [t.address.toLowerCase(), t.symbol]),
);

const TRUSTED_NFT_SET = new Set(
  TRUSTED_NFT_COLLECTIONS.map((address) => address.toLowerCase()),
);

export function trustedSymbolFor(address: string): string | null {
  return TRUSTED_BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

export function isTrustedToken(address: string): boolean {
  return TRUSTED_BY_ADDRESS.has(address.toLowerCase());
}

export function isTrustedNftCollection(address: string): boolean {
  return TRUSTED_NFT_SET.has(address.toLowerCase());
}
