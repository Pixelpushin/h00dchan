"use client";

// NFT/token sections of the wallet page, split out as a client component
// because "show unverified/spam" is pure UI state (no server round trip
// needed) - the server page fetches the real holdings once, this just
// decides what subset to render. Default view is the trusted-only
// allowlist (lib/trustedTokens.ts) since any wallet, including a
// counterfactual TBA that's never been activated, can already receive
// arbitrary junk NFTs/tokens sent by anyone - the toggle exists for anyone
// who wants to see everything anyway.
import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { isTrustedNftCollection, isTrustedToken } from "@/lib/trustedTokens";
import type { WalletHoldings, WalletNft } from "@/lib/alchemy";
import { connectWallet, sendTransaction } from "@/lib/wallet";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { buildSendNftTx } from "@/lib/tba";
import { readOwnerOf, BLOCK_EXPLORER_URL } from "@/lib/chain";

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
  tokenId,
  tbaAddress,
  nfts,
  tokenBalances,
  nftNestedCounts = {},
  nftTrustedTokens = {},
}: {
  tokenId: string;
  tbaAddress: string;
  nfts: WalletHoldings["nfts"];
  tokenBalances: WalletHoldings["tokenBalances"];
  // Keyed by `${contractAddress}-${tokenId}` (same key this component
  // already uses for each NFT's React key) - same "float notable holdings
  // to the top" idea app/collection/page.tsx applies to a holder's own
  // grid, one level deeper: a nested HOODCHAN can itself hold further-
  // nested HOODCHANs or whitelisted ERC-20s. Optional/defaulted since
  // computing this is the SERVER page's job (app/wallet/[tokenId]/page.tsx)
  // - a caller that doesn't have it yet just gets the un-sorted, un-badged
  // grid this component always showed before this feature existed.
  nftNestedCounts?: Record<string, number>;
  nftTrustedTokens?: Record<string, string[]>;
}) {
  const [showAll, setShowAll] = useState(false);

  // Same ownership check as WalletActionsPanel, independently - this
  // component is the one that actually renders the per-NFT send button,
  // and it needs to know locally whether the connected wallet is even
  // allowed to send before showing one. Duplicated rather than threaded
  // down as a prop from a sibling component, so each panel stays a
  // self-contained unit (matches this file's own existing convention of
  // being independently usable, not coupled to WalletActionsPanel's
  // internal state).
  const connectedAddress = useWalletAddress();
  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readOwnerOf(tokenId)
      .then((owner) => {
        if (!cancelled) setOwnerAddress(owner);
      })
      .catch(() => {
        if (!cancelled) setOwnerAddress(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tokenId]);
  const canSend =
    !!connectedAddress &&
    !!ownerAddress &&
    connectedAddress.toLowerCase() === ownerAddress.toLowerCase();

  const [sendingNft, setSendingNft] = useState<WalletNft | null>(null);
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sendTxHash, setSendTxHash] = useState<string | null>(null);

  function openSendModal(nft: WalletNft) {
    setSendingNft(nft);
    setSendRecipient("");
    setSendError(null);
    setSendStatus(null);
    setSendTxHash(null);
  }

  function closeSendModal() {
    if (sendBusy) return; // don't let a stray click close mid-send
    setSendingNft(null);
  }

  async function handleSendNft(e: React.FormEvent) {
    e.preventDefault();
    if (!sendingNft) return;
    const trimmed = sendRecipient.trim();
    if (!isAddress(trimmed)) {
      setSendError("Enter a valid recipient address.");
      return;
    }
    setSendError(null);
    setSendStatus(null);
    setSendBusy(true);
    try {
      const account = await connectWallet();
      if (account.toLowerCase() !== ownerAddress?.toLowerCase()) {
        throw new Error(
          "Connected wallet doesn't currently own this anon - switch wallets and try again.",
        );
      }
      setSendStatus("Confirm the send in your wallet...");
      const tx = buildSendNftTx(
        tbaAddress,
        sendingNft.contractAddress,
        sendingNft.tokenId,
        trimmed,
      );
      const hash = await sendTransaction(account, tx);
      setSendTxHash(hash);
      setSendStatus("Sent - waiting for confirmation on-chain.");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSendBusy(false);
    }
  }

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

  // Same nested-first-then-trusted-token-count sort as app/collection/
  // page.tsx, applied to this nested-one-level-deeper grid.
  function nftSortKey(nft: WalletNft): string {
    return `${nft.contractAddress}-${nft.tokenId}`;
  }
  const sortedNfts = [...(showAll ? nfts : trustedNfts)].sort((a, b) => {
    const nestedDiff =
      (nftNestedCounts[nftSortKey(b)] ?? 0) -
      (nftNestedCounts[nftSortKey(a)] ?? 0);
    if (nestedDiff !== 0) return nestedDiff;
    const tokenDiff =
      (nftTrustedTokens[nftSortKey(b)]?.length ?? 0) -
      (nftTrustedTokens[nftSortKey(a)]?.length ?? 0);
    if (tokenDiff !== 0) return tokenDiff;
    return Number(a.tokenId) - Number(b.tokenId);
  });

  const visibleNfts = sortedNfts;
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
                <div className="relative">
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
                  {(nftNestedCounts[nftSortKey(nft)] ?? 0) > 0 && (
                    <span
                      className="hc-profile-card-nested-badge"
                      title={`${nftNestedCounts[nftSortKey(nft)]} nested HOODCHAN${nftNestedCounts[nftSortKey(nft)] === 1 ? "" : "s"}`}
                    >
                      📦 {nftNestedCounts[nftSortKey(nft)]}
                    </span>
                  )}
                  {(nftTrustedTokens[nftSortKey(nft)]?.length ?? 0) > 0 && (
                    <span
                      className="hc-profile-card-token-badge"
                      title={`Holds: ${nftTrustedTokens[nftSortKey(nft)].join(", ")}`}
                    >
                      💰 {nftTrustedTokens[nftSortKey(nft)].length}
                    </span>
                  )}
                </div>
                <div className="p-1.5 text-center hc-thread-meta text-[0.65rem] truncate">
                  {nft.name ?? `#${nft.tokenId}`}
                </div>
                {canSend && (
                  <button
                    type="button"
                    className="hc-button-ghost hc-button w-full text-[0.65rem] py-1"
                    onClick={() => openSendModal(nft)}
                  >
                    Send
                  </button>
                )}
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

      {sendingNft && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={closeSendModal}
        >
          <div
            className="hc-box w-full max-w-xs p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            {sendingNft.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sendingNft.imageUrl}
                alt={sendingNft.name ?? sendingNft.tokenId}
                className="w-full aspect-square object-cover rounded"
              />
            ) : (
              <div
                className="w-full aspect-square rounded"
                style={{ background: "var(--hc-box-alt)" }}
              />
            )}
            <div className="text-sm font-bold">
              {sendingNft.name ?? `#${sendingNft.tokenId}`}
            </div>
            <form className="flex flex-col gap-2" onSubmit={handleSendNft}>
              <input
                className="hc-form-input"
                placeholder="to (0x...)"
                value={sendRecipient}
                onChange={(e) => setSendRecipient(e.target.value)}
                disabled={sendBusy}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="hc-button-urgent flex-1 text-sm"
                  disabled={sendBusy}
                >
                  {sendBusy ? "Working..." : "send"}
                </button>
                <button
                  type="button"
                  className="hc-button-ghost hc-button flex-1 text-sm"
                  onClick={closeSendModal}
                  disabled={sendBusy}
                >
                  cancel
                </button>
              </div>
            </form>
            {sendStatus && (
              <p
                className="hc-thread-meta text-xs"
                style={{ color: "var(--hc-greentext)" }}
              >
                {sendStatus}
              </p>
            )}
            {sendError && (
              <p className="text-xs" style={{ color: "var(--hc-danger)" }}>
                {sendError}
              </p>
            )}
            {sendTxHash && (
              <a
                href={`${BLOCK_EXPLORER_URL}/tx/${sendTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hc-link text-xs font-mono break-all"
              >
                view transaction
              </a>
            )}
          </div>
        </div>
      )}
    </>
  );
}
