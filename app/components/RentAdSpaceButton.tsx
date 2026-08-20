"use client";

// "Rent this ad space" - lets anyone pay to run their own OpenSea
// collection as a banner ad (see app/api/ads/route.ts for the actual
// validate+verify+queue logic). No modal library - a fixed-position
// overlay + plain React state, matching this repo's existing
// no-extra-dependency style.
//
// Pays via a real wallet popup (sendTransaction) instead of asking someone
// to pay externally and paste a tx hash back in - confirmed live as a real
// failure mode: a user paid, hit a transient RPC lookup error pasting the
// hash back in, and lost the browser state entirely with no way to
// recover it. Sending the transaction FROM this component means the tx
// hash is already in hand the instant it's broadcast - nothing to copy,
// nothing to lose, and submission fires automatically right after.
import { useCallback, useState } from "react";
import { Interface, parseEther, parseUnits } from "ethers";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { connectWallet, sendTransaction } from "@/lib/wallet";
import {
  AD_PRICE_TABLE,
  AD_SLOT_DAYS,
  AD_TREASURY_ADDRESS,
  findAdPrice,
} from "@/lib/adConfig";

interface Quote {
  amount: number;
  usdPrice: number;
}

// Padding above the displayed quote before sending - the server re-checks
// against a FRESH quote at verification time with its own 5% tolerance
// (lib/adPayment.ts's PRICE_TOLERANCE), so a small buffer here just
// absorbs normal price drift between opening this modal and clicking pay,
// not a second source of truth.
const PAYMENT_BUFFER = 1.03;

const erc20Interface = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

type Stage = "idle" | "paying" | "submitting" | "done";

export function RentAdSpaceButton() {
  const [open, setOpen] = useState(false);
  const address = useWalletAddress();
  const [openseaUrl, setOpenseaUrl] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState(
    AD_PRICE_TABLE[0]?.symbol ?? "ETH",
  );
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [paidTxHash, setPaidTxHash] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Called directly from real event handlers (opening the modal, changing
  // the token dropdown) rather than an effect reacting to state - pricing
  // is live/USD-denominated (lib/adConfig.ts's AD_PRICE_USD), so this has
  // to be a fresh fetch, not a static number.
  const fetchQuote = useCallback(async (symbol: string) => {
    setQuoteLoading(true);
    setQuote(null);
    try {
      const res = await fetch(`/api/ads/quote?token=${symbol}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Unable to fetch a quote.");
      setQuote({ amount: body.amount, usdPrice: body.usdPrice });
    } catch {
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  const handleOpen = () => {
    setOpen(true);
    setError(null);
    setResult(null);
    setPaidTxHash(null);
    setStage("idle");
    fetchQuote(tokenSymbol);
  };

  const handleTokenChange = (symbol: string) => {
    setTokenSymbol(symbol);
    fetchQuote(symbol);
  };

  const submitAd = useCallback(
    async (txHash: string, submitterAddress: string) => {
      setStage("submitting");
      setError(null);
      try {
        const res = await fetch("/api/ads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            openseaUrl,
            txHash,
            tokenSymbol,
            submitterAddress,
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(body?.error ?? `Submission failed (${res.status}).`);
        }
        setResult("Submitted for review - we'll approve it within a day.");
        setStage("done");
        setOpenseaUrl("");
      } catch (err) {
        // Payment already went through and its hash is still right here in
        // state (paidTxHash) - a failed submission just means "retry
        // submitting," never "you need to pay again."
        setError(err instanceof Error ? err.message : "Submission failed.");
        setStage("idle");
      }
    },
    [openseaUrl, tokenSymbol],
  );

  const handlePayAndSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!openseaUrl.trim()) {
      setError("Enter your OpenSea collection URL first.");
      return;
    }

    // Already paid, just retrying a failed submission - must NOT send a
    // second payment. This was the actual bug in the first version of this
    // fix: the retry button called straight back into the payment path.
    if (paidTxHash) {
      const retryAddress = address;
      if (!retryAddress) {
        setError("Reconnect your wallet to retry - it needs your address.");
        return;
      }
      await submitAd(paidTxHash, retryAddress);
      return;
    }

    const price = findAdPrice(tokenSymbol);
    if (!price || !quote) {
      setError("No live quote yet - try reopening this window.");
      return;
    }
    setError(null);
    setStage("paying");
    try {
      const payAddress = address ?? (await connectWallet());
      const paddedAmount = quote.amount * PAYMENT_BUFFER;

      const tx =
        price.tokenAddress === null
          ? {
              to: AD_TREASURY_ADDRESS,
              data: "0x",
              value: parseEther(paddedAmount.toFixed(18)).toString(),
            }
          : {
              to: price.tokenAddress,
              data: erc20Interface.encodeFunctionData("transfer", [
                AD_TREASURY_ADDRESS,
                parseUnits(
                  paddedAmount.toFixed(price.decimals),
                  price.decimals,
                ),
              ]),
              value: "0",
            };

      const hash = await sendTransaction(payAddress, tx);
      setPaidTxHash(hash);
      await submitAd(hash, payAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed.");
      setStage("idle");
    }
  };

  return (
    <>
      <button
        onClick={handleOpen}
        className="hc-button-ghost hc-button text-xs"
      >
        Rent this ad space
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setOpen(false)}
        >
          <div
            className="hc-box w-full max-w-lg max-h-[85vh] overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="hc-title text-lg">Rent this ad space</h2>
              <button
                onClick={() => setOpen(false)}
                className="hc-infobox-close"
                style={{ color: "var(--hc-maroon)" }}
              >
                [x]
              </button>
            </div>

            <div className="hc-thread-meta text-sm mb-4 flex flex-col gap-1">
              <p>
                {quoteLoading
                  ? "Fetching current price..."
                  : quote
                    ? `~${quote.amount.toFixed(6)} ${tokenSymbol} (≈ $${quote.usdPrice}) for ${AD_SLOT_DAYS} days`
                    : "Unable to fetch a live quote right now."}{" "}
                in the rotating banner, linking to your own OpenSea collection.
              </p>
              <p>
                Every submission is manually reviewed before it goes live -
                usually within a day. Payment is non-refundable except at our
                discretion (e.g. a mistaken submission).
              </p>
            </div>

            {paidTxHash && stage === "idle" && error && (
              <p className="hc-thread-meta text-xs mb-2 break-all">
                Payment already sent ({paidTxHash.slice(0, 10)}...) - retrying
                submission won&apos;t charge you again.
              </p>
            )}

            <form onSubmit={handlePayAndSubmit} className="flex flex-col gap-2">
              <label className="hc-thread-meta text-xs">
                OpenSea collection URL
              </label>
              <input
                value={openseaUrl}
                onChange={(e) => setOpenseaUrl(e.target.value)}
                placeholder="https://opensea.io/collection/your-collection"
                className="hc-form-input"
                disabled={stage !== "idle"}
                required
              />

              <label className="hc-thread-meta text-xs">Pay in</label>
              <select
                value={tokenSymbol}
                onChange={(e) => handleTokenChange(e.target.value)}
                className="hc-form-input"
                disabled={stage !== "idle"}
              >
                {AD_PRICE_TABLE.map((entry) => (
                  <option key={entry.symbol} value={entry.symbol}>
                    {entry.symbol}
                  </option>
                ))}
              </select>

              <button
                type="submit"
                disabled={stage !== "idle" || quoteLoading || !quote}
                className="hc-button mt-2"
              >
                {stage === "paying"
                  ? "Confirm in your wallet..."
                  : stage === "submitting"
                    ? "Payment sent, submitting..."
                    : paidTxHash
                      ? "Retry submission"
                      : "Pay & submit for review"}
              </button>

              {result && (
                <p className="text-sm" style={{ color: "var(--hc-greentext)" }}>
                  {result}
                </p>
              )}
              {error && (
                <p className="text-sm" style={{ color: "var(--hc-danger)" }}>
                  {error}
                </p>
              )}
            </form>
          </div>
        </div>
      )}
    </>
  );
}
