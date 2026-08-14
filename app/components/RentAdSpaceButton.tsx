"use client";

// "Rent this ad space" - lets anyone pay to run their own OpenSea
// collection as a banner ad (see app/api/ads/route.ts for the actual
// validate+verify+queue logic). No modal library - a fixed-position
// overlay + plain React state, matching this repo's existing
// no-extra-dependency style.
import { useCallback, useState } from "react";
import { useWalletAddress } from "@/lib/useWalletAddress";
import {
  AD_PRICE_TABLE,
  AD_SLOT_DAYS,
  AD_TREASURY_ADDRESS,
} from "@/lib/adConfig";

interface Quote {
  amount: number;
  usdPrice: number;
}

export function RentAdSpaceButton() {
  const [open, setOpen] = useState(false);
  const address = useWalletAddress();
  const [openseaUrl, setOpenseaUrl] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState(
    AD_PRICE_TABLE[0]?.symbol ?? "ETH",
  );
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [submitterAddress, setSubmitterAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveSubmitter = submitterAddress || address || "";

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
    fetchQuote(tokenSymbol);
  };

  const handleTokenChange = (symbol: string) => {
    setTokenSymbol(symbol);
    fetchQuote(symbol);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          openseaUrl,
          txHash,
          tokenSymbol,
          submitterAddress: effectiveSubmitter,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `Submission failed (${res.status}).`);
      }
      setResult("Submitted for review - we'll approve it within a day.");
      setOpenseaUrl("");
      setTxHash("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setSubmitting(false);
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
              <p className="break-all">
                Treasury address:{" "}
                <span className="font-mono">
                  {AD_TREASURY_ADDRESS || "not configured yet"}
                </span>
              </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-2">
              <label className="hc-thread-meta text-xs">
                OpenSea collection URL
              </label>
              <input
                value={openseaUrl}
                onChange={(e) => setOpenseaUrl(e.target.value)}
                placeholder="https://opensea.io/collection/your-collection"
                className="hc-form-input"
                required
              />

              <label className="hc-thread-meta text-xs">Pay in</label>
              <select
                value={tokenSymbol}
                onChange={(e) => handleTokenChange(e.target.value)}
                className="hc-form-input"
              >
                {AD_PRICE_TABLE.map((entry) => (
                  <option key={entry.symbol} value={entry.symbol}>
                    {entry.symbol}
                  </option>
                ))}
              </select>

              <label className="hc-thread-meta text-xs">
                Transaction hash (after sending payment to the treasury address
                above)
              </label>
              <input
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x..."
                className="hc-form-input"
                required
              />

              <label className="hc-thread-meta text-xs">
                Your wallet address
              </label>
              <input
                value={effectiveSubmitter}
                onChange={(e) => setSubmitterAddress(e.target.value)}
                placeholder="0x..."
                className="hc-form-input"
                required
              />

              <button
                type="submit"
                disabled={submitting}
                className="hc-button mt-2"
              >
                {submitting ? "Submitting..." : "Submit for review"}
              </button>

              {result && (
                <p className="text-sm" style={{ color: "var(--hc-greentext)" }}>
                  {result}
                </p>
              )}
              {error && (
                <p className="text-sm" style={{ color: "#a12b2b" }}>
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
