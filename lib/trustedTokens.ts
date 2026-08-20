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

// CHAN and HOODIE's addresses + symbols confirmed live via eth_call
// (symbol(), name(), decimals(), totalSupply() for HOODIE) against
// Robinhood Chain directly - real deployed ERC-20s, 18 decimals each - not
// just taken on trust from the address alone, same verification standard
// as adConfig.ts's USDG entry.
export const TRUSTED_TOKENS: TrustedToken[] = [
  { address: "0xb36fd5d3392c78e70c3e08f46b46f242e7ef654f", symbol: "CHAN" },
  { address: "0xc72c01aab5f5678dc1d6f5c6d2b417d91d402ba3", symbol: "HOODIE" },
];

// Same idea as TRUSTED_TOKENS but for NFT collection contracts - the wallet
// explorer (app/wallet/[tokenId]/page.tsx) uses this to hide spam-airdropped
// NFT collections behind a toggle by default, same as spam ERC-20s.
// HOODCHAN's own collection (lib/chain.ts's CONTRACT) belongs here as the
// very first entry - the site's own native NFT was getting hidden behind
// the spam toggle on its own wallet pages, which defeats the point of the
// toggle (it's meant to hide junk airdrops, not the site's own collection).
export const TRUSTED_NFT_COLLECTIONS: string[] = [
  "0x774db2207d26570f5638028839c816702a40abc2", // HOODCHAN
];

const TRUSTED_BY_ADDRESS = new Map(
  TRUSTED_TOKENS.map((t) => [t.address.toLowerCase(), t.symbol]),
);

const TRUSTED_NFT_SET = new Set(
  TRUSTED_NFT_COLLECTIONS.map((address) => address.toLowerCase()),
);

export function isTrustedToken(address: string): boolean {
  return TRUSTED_BY_ADDRESS.has(address.toLowerCase());
}

export function isTrustedNftCollection(address: string): boolean {
  return TRUSTED_NFT_SET.has(address.toLowerCase());
}
