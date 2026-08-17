// Real (non-fictional) wallet holdings for an anon's own token-bound
// account, trust-filtered before it's allowed anywhere near the AI prompt.
// A TBA can already receive real assets today with zero deployment (see
// lib/tba.ts), which means anyone can send anything - including obvious
// spam/scam tokens - to any anon's wallet. Without a trust filter, an AI
// persona "discussing what it holds" would be trivially manipulable into
// hyping up whatever junk someone airdropped it. lib/trustedTokens.ts is
// the hand-curated allowlist that keeps "real holdings worth mentioning"
// separate from "random junk that showed up," and this is also the seed
// list for the future Alpha Bot - what an anon actually, verifiably holds
// is what tells it what's worth researching, not every spam token that
// got sent to farm attention.
import { computeTbaAddress } from "@/lib/tba";
import { fetchWalletHoldings } from "@/lib/alchemy";
import { isTrustedToken } from "@/lib/trustedTokens";

export interface AiWalletContext {
  ethWei: string;
  trustedHoldings: Array<{ symbol: string; amount: string }>;
  spamTokenCount: number;
}

function formatAmount(rawBalance: string, decimals: number | null): string {
  if (decimals === null) return "some";
  const amount = BigInt(rawBalance);
  const unit = BigInt(10) ** BigInt(decimals);
  const whole = amount / unit;
  const frac = amount % unit;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .slice(0, 4)
    .replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

// Never throws - a wallet-lookup hiccup (Alchemy blip, RPC blip) must
// never break AI generation. Returns null on any failure, same "just
// don't include this context" fallback as a token with nothing in it.
export async function getAiWalletContext(
  tokenId: string,
): Promise<AiWalletContext | null> {
  try {
    const tbaAddress = await computeTbaAddress(tokenId);
    const holdings = await fetchWalletHoldings(tbaAddress);
    const trustedHoldings = holdings.tokenBalances
      .filter((t) => isTrustedToken(t.contractAddress))
      .map((t) => ({
        symbol: t.symbol ?? "an unnamed verified token",
        amount: formatAmount(t.balance, t.decimals),
      }));
    const spamTokenCount =
      holdings.tokenBalances.length - trustedHoldings.length;
    return { ethWei: holdings.ethBalanceWei, trustedHoldings, spamTokenCount };
  } catch {
    return null;
  }
}
