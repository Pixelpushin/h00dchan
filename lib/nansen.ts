// Nansen API client for the Alpha Bot (lib/alphaBotResearch.ts) - real
// on-chain wallet research, not the fake AI-shitpost bucket the rest of
// this app's AI posts fall into. Server-only - NANSEN_API_KEY is not
// NEXT_PUBLIC_. Confirmed live before writing this: the "robinhood" chain
// slug is accepted by the current-balance endpoint (empty result for an
// address with no balance, not an "unsupported chain" error), and "all"
// works for labels (queries across every chain Nansen covers, not just
// Robinhood Chain) - so a HOODCHAN anon's cross-chain footprint, not just
// its Robinhood Chain balance, is what gets researched.
const NANSEN_API_BASE = "https://api.nansen.ai/api/v1";
const FETCH_TIMEOUT_MS = 15_000;

function apiKey(): string {
  const key = process.env.NANSEN_API_KEY;
  if (!key) throw new Error("NANSEN_API_KEY is not configured.");
  return key;
}

async function nansenPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${NANSEN_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: apiKey(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nansen ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export interface NansenBalance {
  chain: string;
  tokenSymbol: string;
  tokenName: string;
  amount: number;
  priceUsd: number;
  valueUsd: number;
}

interface NansenBalanceItem {
  chain?: string;
  token_symbol?: string;
  token_name?: string;
  token_amount?: number;
  price_usd?: number;
  value_usd?: number;
}

// "all" queries every chain Nansen covers in one call - deliberately not
// scoped to just "robinhood", since a real anon's on-chain footprint
// (what makes for interesting research) is very likely elsewhere too, not
// just on this month-old chain.
export async function fetchAddressBalances(
  address: string,
): Promise<NansenBalance[]> {
  const result = await nansenPost<{ data?: NansenBalanceItem[] }>(
    "/profiler/address/current-balance",
    { address, chain: "all", hide_spam_token: true },
  );
  return (result.data ?? []).map((item) => ({
    chain: item.chain ?? "unknown",
    tokenSymbol: item.token_symbol ?? "?",
    tokenName: item.token_name ?? "Unknown token",
    amount: item.token_amount ?? 0,
    priceUsd: item.price_usd ?? 0,
    valueUsd: item.value_usd ?? 0,
  }));
}

export interface NansenLabel {
  label: string;
  category: string;
}

interface NansenLabelItem {
  label?: string;
  category?: string;
}

// Nansen's Data Redistribution Guidelines (docs.nansen.ai/guides/
// data-redistribution-guidelines, incorporated into the API Terms of
// Service at nansen.ai/legal/api) single out "smart_money" as their most
// protected label category - redistribution requires prior written
// approval AND significant transformation, and some of it is "not allowed
// under any circumstances." Alpha Bot has neither of those, so smart_money
// labels are dropped here, at the data-fetch boundary, before anything
// downstream (the Venice prompt, a public board post) ever sees them -
// every other category (behavioral/defi/cefi/nft/social/others) is a
// simple factual tag (e.g. "high balance," "NFT collector"), not Nansen's
// proprietary trader/fund classification.
const REDISTRIBUTABLE_LABEL_CATEGORIES = new Set([
  "behavioral",
  "defi",
  "cefi",
  "nft",
  "social",
  "others",
]);

export async function fetchAddressLabels(
  address: string,
): Promise<NansenLabel[]> {
  const result = await nansenPost<{ data?: NansenLabelItem[] }>(
    "/profiler/address/labels",
    { address, chain: "all" },
  );
  return (result.data ?? [])
    .filter((item): item is Required<NansenLabelItem> =>
      Boolean(item.label && item.category),
    )
    .filter((item) =>
      REDISTRIBUTABLE_LABEL_CATEGORIES.has(item.category.toLowerCase()),
    )
    .map((item) => ({ label: item.label, category: item.category }));
}
