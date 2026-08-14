// Plain config, not a smart contract - per the approved plan, ad rental for
// this pass is a simple "pay a fixed amount to a treasury address, get
// manually reviewed" flow, not an on-chain escrow/whitelist system. Adding
// a new accepted token later just means adding a row here plus the
// matching ERC-20 branch in lib/adPayment.ts - no contract redeploy.
//
// NEXT_PUBLIC_ on purpose, unlike most secrets in this repo: a receiving
// wallet address isn't sensitive - it HAS to be shown to advertisers in the
// "Rent this ad space" modal so they know where to send payment, and it's
// trivially visible on-chain the moment anyone pays it anyway. MUST be set
// to a real wallet address before this feature can accept any payment -
// verifyAdPayment (lib/adPayment.ts) checks every submitted transaction
// against it. There is no safe default.
export const AD_TREASURY_ADDRESS =
  process.env.NEXT_PUBLIC_AD_TREASURY_ADDRESS ?? "";

export const AD_SLOT_DAYS = 7;

// Priced in USD, paid in whatever's whitelisted below - lib/priceFeed.ts
// converts to a live token amount at both quote-display and payment-
// verification time, so this number doesn't go stale as ETH's price moves.
export const AD_PRICE_USD = 25;

export interface AdPriceEntry {
  symbol: string;
  tokenAddress: string | null; // null = native ETH
  decimals: number;
  coingeckoId: string; // lib/priceFeed.ts's lookup key for this token's live USD price
}

// USDC is intentionally NOT listed yet: a live Blockscout token search on
// Robinhood Chain turned up FOUR different unverified ERC-20 contracts all
// using the "USDC" ticker (one literally named "United States Dump Coin"),
// with no official Circle deployment confirmed on this chain. Whitelisting
// the wrong one would mean silently accepting a worthless token as full
// payment. Add a row here once a real, verified USDC contract address is
// confirmed - not before.
export const AD_PRICE_TABLE: AdPriceEntry[] = [
  { symbol: "ETH", tokenAddress: null, decimals: 18, coingeckoId: "ethereum" },
];

export function findAdPrice(symbol: string): AdPriceEntry | undefined {
  return AD_PRICE_TABLE.find(
    (entry) => entry.symbol.toLowerCase() === symbol.toLowerCase(),
  );
}
