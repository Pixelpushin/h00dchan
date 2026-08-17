"use client";

// NFT/token sections of the wallet page, split out as a client component
// because "show unverified/spam" is pure UI state (no server round trip
// needed) - the server page fetches the real holdings once, this just
// decides what subset to render. Default view is the trusted-only
// allowlist (lib/trustedTokens.ts) since any wallet, including a
// counterfactual TBA that's never been activated, can already receive
// arbitrary junk NFTs/tokens sent by anyone - the toggle exists for anyone
// who wants to see everything anyway.
import { useState } from "react";
import { isTrustedNftCollection, isTrustedToken } from "@/lib/trustedTokens";
import type { WalletHoldings } from "@/lib/alchemy";

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Mirrors the wallet page's formatEth, but for an arbitrary ERC-20's
// decimals instead of the hardcoded 18 for ETH.
function formatTokenAmount(rawBalance: string, decimals: number): string {
  const amount = BigInt(rawBalance);
  if (decimals <= 0) return amount.toString();
  const unit = BigInt(10) ** BigInt(decimals);
  const whole = amount / unit;
  const frac = amount % unit;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${fracStr}`;
}

export function WalletHoldingsView({
  nfts,
  tokenBalances,
}: {
  nfts: WalletHoldings["nfts"];
  tokenBalances: WalletHoldings["tokenBalances"];
}) {
  const [showAll, setShowAll] = useState(false);

  const trustedNfts = nfts.filter((nft) =>
    isTrustedNftCollection(nft.contractAddress),
  );
  const trustedTokens = tokenBalances.filter((token) =>
    isTrustedToken(token.contractAddress),
  );
  const hiddenCount =
    nfts.length -
    trustedNfts.length +
    (tokenBalances.length - trustedTokens.length);

  const visibleNfts = showAll ? nfts : trustedNfts;
  const visibleTokens = showAll ? tokenBalances : trustedTokens;

  return (
    <>
      <div className="hc-box p-4 flex flex-wrap items-center justify-between gap-3">
        <span className="hc-thread-meta text-xs">
          {hiddenCount > 0
            ? `spam filter: ${hiddenCount} unverified item${hiddenCount === 1 ? "" : "s"} hidden`
            : "spam filter: nothing hidden"}
        </span>
        <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
          <span className="hc-thread-meta">show unverified / spam</span>
          <span className={`hc-toggle${showAll ? " hc-toggle-on" : ""}`}>
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="hc-toggle-input"
              aria-label="Show unverified or unwhitelisted NFTs and tokens"
            />
            <span className="hc-toggle-thumb" />
          </span>
        </label>
      </div>

      <div className="hc-box p-4">
        <div className="hc-thread-meta text-xs mb-2">
          NFTs ({visibleNfts.length})
        </div>
        {visibleNfts.length === 0 ? (
          <p className="hc-thread-meta text-sm">
            {nfts.length === 0
              ? "Nothing in this wallet yet."
              : "No whitelisted NFTs - toggle above to see unverified ones."}
          </p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {visibleNfts.map((nft) => (
              <div
                key={`${nft.contractAddress}-${nft.tokenId}`}
                className="hc-box overflow-hidden"
              >
                {nft.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={nft.imageUrl}
                    alt={nft.name ?? nft.tokenId}
                    className="w-full aspect-square object-cover"
                  />
                ) : (
                  <div
                    className="w-full aspect-square"
                    style={{ background: "var(--hc-box-alt)" }}
                  />
                )}
                <div className="p-1.5 text-center hc-thread-meta text-[0.65rem] truncate">
                  {nft.name ?? `#${nft.tokenId}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hc-box p-4">
        <div className="hc-thread-meta text-xs mb-2">
          Tokens ({visibleTokens.length})
        </div>
        {visibleTokens.length === 0 ? (
          <p className="hc-thread-meta text-sm">
            {tokenBalances.length === 0
              ? "No ERC-20 balances in this wallet yet."
              : "No whitelisted tokens - toggle above to see unverified ones."}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {visibleTokens.map((token) => {
              const label =
                token.symbol ??
                token.name ??
                truncateAddress(token.contractAddress);
              const amount =
                token.decimals !== null
                  ? formatTokenAmount(token.balance, token.decimals)
                  : `${BigInt(token.balance).toString()} (raw units)`;
              return (
                <div
                  key={token.contractAddress}
                  className="flex items-center justify-between font-mono text-xs"
                >
                  <span>{label}</span>
                  <span className="hc-thread-meta">{amount}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
