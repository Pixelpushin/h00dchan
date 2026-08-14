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

export interface AdPriceEntry {
  symbol: string;
  tokenAddress: string | null; // null = native ETH
  amount: string; // human units, e.g. "0.05" ETH - parsed to wei at verify time
  decimals: number;
}

export const AD_PRICE_TABLE: AdPriceEntry[] = [
  { symbol: "ETH", tokenAddress: null, amount: "0.05", decimals: 18 },
];

export function findAdPrice(symbol: string): AdPriceEntry | undefined {
  return AD_PRICE_TABLE.find(
    (entry) => entry.symbol.toLowerCase() === symbol.toLowerCase(),
  );
}
