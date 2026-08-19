// Server-side proof-of-payment check for the ad-rental flow - the
// submission form does not "confirm" anything client-side; this is the
// actual verification. Raw RPC via lib/chain.ts's rpcCall, same pattern as
// lib/tba.ts. No escrow contract (see lib/adConfig.ts's own comment): a
// submitter pays AD_TREASURY_ADDRESS directly and this looks up the
// resulting tx hash (see app/components/RentAdSpaceButton.tsx - the site
// itself sends the payment and captures the hash now, rather than asking
// someone to paste one in by hand).
import { rpcCall } from "@/lib/chain";
import { AD_PRICE_USD, AD_TREASURY_ADDRESS, findAdPrice } from "@/lib/adConfig";
import { usdToTokenAmount } from "@/lib/priceFeed";

// Confirmed live in production: a single unretried rpcCall against
// Robinhood Chain's documented-flaky public RPC surfaced as "Unable to
// look up that transaction right now" for a REAL payment a real user had
// just made - the exact class of bug already fixed elsewhere in this
// codebase (lib/chain.ts's fetchWalletTokensOnChain, etc), just not here
// yet. Real money on the line makes this the highest-priority place for
// it. One retry with a short backoff, not a full gateway swap - this file
// only ever makes two RPC calls per verification (cheap either way).
async function retryRpcCall<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await rpcCall<T>(method, params);
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

// Payments are allowed to clear at slightly less than the live-quoted
// amount - the advertiser sent a fixed token amount based on whatever the
// price was AT THAT MOMENT, which may have drifted a little by the time
// this runs. 5% covers normal short-window volatility without opening a
// meaningful underpayment loophole.
const PRICE_TOLERANCE = 0.95;

interface TxReceipt {
  status: string; // "0x1" success, "0x0" reverted
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

interface Tx {
  to: string | null;
  value: string; // hex wei
  from: string;
}

const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function parseUnitsToWei(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(whole || "0") * BigInt(10) ** BigInt(decimals) +
    BigInt(fracPadded || "0")
  );
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

export type PaymentVerification = { ok: true } | { ok: false; reason: string };

export async function verifyAdPayment(
  txHash: string,
  tokenSymbol: string,
): Promise<PaymentVerification> {
  if (!AD_TREASURY_ADDRESS) {
    return { ok: false, reason: "Ad payments are not configured yet." };
  }
  const price = findAdPrice(tokenSymbol);
  if (!price) {
    return { ok: false, reason: `${tokenSymbol} is not an accepted token.` };
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, reason: "Invalid transaction hash." };
  }

  let receipt: TxReceipt | null;
  try {
    receipt = await retryRpcCall<TxReceipt | null>(
      "eth_getTransactionReceipt",
      [txHash],
    );
  } catch {
    return {
      ok: false,
      reason: "Unable to look up that transaction right now.",
    };
  }
  if (!receipt) {
    return {
      ok: false,
      reason: "Transaction not found (or not yet confirmed).",
    };
  }
  if (receipt.status !== "0x1") {
    return { ok: false, reason: "That transaction failed on-chain." };
  }

  let requiredTokenAmount: number;
  try {
    requiredTokenAmount = await usdToTokenAmount(
      AD_PRICE_USD,
      price.coingeckoId,
    );
  } catch {
    return {
      ok: false,
      reason:
        "Unable to look up the current price right now - try again shortly.",
    };
  }
  const requiredWei = parseUnitsToWei(
    (requiredTokenAmount * PRICE_TOLERANCE).toFixed(price.decimals),
    price.decimals,
  );

  if (price.tokenAddress === null) {
    // Native ETH transfer - value lives on the tx itself, not the receipt.
    let tx: Tx | null;
    try {
      tx = await retryRpcCall<Tx | null>("eth_getTransactionByHash", [txHash]);
    } catch {
      return {
        ok: false,
        reason: "Unable to look up that transaction right now.",
      };
    }
    if (!tx || !tx.to) {
      return { ok: false, reason: "Transaction not found." };
    }
    if (!addressesEqual(tx.to, AD_TREASURY_ADDRESS)) {
      return {
        ok: false,
        reason: "That payment wasn't sent to the ad treasury address.",
      };
    }
    if (BigInt(tx.value) < requiredWei) {
      return {
        ok: false,
        reason: "That payment is less than the required amount.",
      };
    }
    return { ok: true };
  }

  // ERC-20 - amount moved is a Transfer event log, not the tx's own value.
  const transferLog = receipt.logs.find(
    (log) =>
      addressesEqual(log.address, price.tokenAddress!) &&
      log.topics[0] === TRANSFER_EVENT_TOPIC &&
      addressesEqual(topicToAddress(log.topics[2]), AD_TREASURY_ADDRESS),
  );
  if (!transferLog) {
    return {
      ok: false,
      reason:
        "No matching token transfer to the ad treasury address found in that transaction.",
    };
  }
  const transferredWei = BigInt(transferLog.data);
  if (transferredWei < requiredWei) {
    return {
      ok: false,
      reason: "That payment is less than the required amount.",
    };
  }
  return { ok: true };
}
