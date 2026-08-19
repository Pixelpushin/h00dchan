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
// Temporarily dropped from $25 to make real end-to-end testing (the new
// pay-via-wallet-popup flow, see RentAdSpaceButton.tsx) cheap while
// there's real ETH on the line - raise this back before announcing the
// feature publicly.
export const AD_PRICE_USD = 0.25;

export interface AdPriceEntry {
  symbol: string;
  tokenAddress: string | null; // null = native ETH
  decimals: number;
  coingeckoId: string; // lib/priceFeed.ts's lookup key for this token's live USD price
}

// USDC is intentionally NOT listed: a live Blockscout token search on
// Robinhood Chain turned up FOUR different unverified ERC-20 contracts all
// using the "USDC" ticker (one literally named "United States Dump Coin"),
// with no official Circle deployment confirmed on this chain. Whitelisting
// the wrong one would mean silently accepting a worthless token as full
// payment. Add a row here only if a real, verified USDC contract address
// is later confirmed the same way USDG was below.
//
// USDG's address was cross-checked against four independent sources before
// being added here: Paxos's own docs (docs.paxos.com/guides/stablecoin/
// usdg/mainnet, listing this exact address for "Robinhood Mainnet"), the
// Global Dollar Network's own launch announcement, Blockscout's verified-
// contract flag (is_verified: true, EIP-1967 proxy), and a direct
// eth_call against Robinhood Chain's own RPC confirming name()="Global
// Dollar", symbol()="USDG", decimals()=6 live on-chain. Decimals is 6 here
// - USDG uses 18 decimals on some other chains (Ethereum, Ink), do not
// copy that value if this ever gets ported elsewhere.
export const AD_PRICE_TABLE: AdPriceEntry[] = [
  { symbol: "ETH", tokenAddress: null, decimals: 18, coingeckoId: "ethereum" },
  {
    symbol: "USDG",
    tokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 6,
    coingeckoId: "global-dollar",
  },
];

export function findAdPrice(symbol: string): AdPriceEntry | undefined {
  return AD_PRICE_TABLE.find(
    (entry) => entry.symbol.toLowerCase() === symbol.toLowerCase(),
  );
}
