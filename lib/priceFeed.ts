// Live USD price lookup for the ad-rental feature's USD-denominated
// pricing (see lib/adConfig.ts's AD_PRICE_USD) - CoinGecko's free public
// endpoint, confirmed live before wiring this up
// (curl api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd
// returned a real price with no API key needed). No caching layer for this
// pass - call volume is bounded by how often someone opens the rent-ad
// modal or submits a payment, nowhere near CoinGecko's public rate limit.
const FETCH_TIMEOUT_MS = 8_000;

export async function getUsdPrice(coingeckoId: string): Promise<number> {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) {
    throw new Error(`Price lookup failed (${res.status})`);
  }
  const data = await res.json();
  const price = data?.[coingeckoId]?.usd;
  if (typeof price !== "number" || price <= 0) {
    throw new Error(`No USD price returned for ${coingeckoId}`);
  }
  return price;
}

// Required token amount (human units, e.g. "0.0133") for a given USD
// price - decimals-aware so callers can go straight to display or to
// lib/adPayment.ts's wei conversion.
export async function usdToTokenAmount(
  usdAmount: number,
  coingeckoId: string,
): Promise<number> {
  const usdPrice = await getUsdPrice(coingeckoId);
  return usdAmount / usdPrice;
}
