"use client";

// Live TBA actions for the wallet page: activate (one-time createAccount)
// and send (execute()) ETH or a held ERC-20 out of the wallet. Gated to
// the anon's actual current owner - anyone can view a wallet page, but
// only the connected wallet matching on-chain ownerOf(tokenId) can
// activate or send from it (the account contract enforces this itself via
// isValidSigner, this is just a UI-level check to avoid showing a button
// that would only revert).
import { useEffect, useMemo, useState } from "react";
import { isAddress, parseUnits } from "ethers";
import { connectWallet, sendTransaction } from "@/lib/wallet";
import { useWalletAddress } from "@/lib/useWalletAddress";
import {
  buildCreateAccountTx,
  buildSendEthTx,
  buildSendTokenTx,
  isTbaActivated,
} from "@/lib/tba";
import { readOwnerOf, BLOCK_EXPLORER_URL } from "@/lib/chain";
import type { WalletHoldings } from "@/lib/alchemy";

interface AssetOption {
  key: string; // "eth" or the ERC-20 contract address
  label: string;
  decimals: number;
  balanceRaw: string;
}

type EnsStatus = "idle" | "loading" | "resolved" | "error";

// Only worth a resolve attempt if it can't already be a raw address and
// looks like a dotted name (".eth" or any other TLD) - avoids firing a
// request on every keystroke of a pasted 0x address.
function looksLikeEnsName(value: string): boolean {
  // isAddress is typed `value is string`, which (since `value` here is
  // already a string) makes TS narrow the negated branch to `never` if
  // checked inline - booleanising through Boolean() sidesteps that without
  // changing behavior.
  const isRawAddress: boolean = Boolean(isAddress(value));
  return !isRawAddress && value.includes(".");
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Polls isTbaActivated after sending the createAccount tx - the RPC needs
// the transaction actually mined before the account has real code, and
// there's no receipt-watching helper in this codebase yet worth adding
// just for this one call site.
async function waitForActivation(tbaAddress: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await isTbaActivated(tbaAddress)) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

export function WalletActionsPanel({
  tokenId,
  tbaAddress,
  initialActivated,
  ethBalanceWei,
  tokenBalances,
}: {
  tokenId: string;
  tbaAddress: string;
  initialActivated: boolean;
  ethBalanceWei: string;
  tokenBalances: WalletHoldings["tokenBalances"];
}) {
  const connectedAddress = useWalletAddress();
  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  const [activated, setActivated] = useState(initialActivated);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

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

  const assets = useMemo<AssetOption[]>(
    () => [
      { key: "eth", label: "ETH", decimals: 18, balanceRaw: ethBalanceWei },
      ...tokenBalances.map((token) => ({
        key: token.contractAddress,
        label: token.symbol ?? token.name ?? token.contractAddress,
        decimals: token.decimals ?? 18,
        balanceRaw: token.balance,
      })),
    ],
    [ethBalanceWei, tokenBalances],
  );

  const [assetKey, setAssetKey] = useState("eth");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  // Resolution results are keyed by the exact recipient text they were
  // resolved/errored for (ensResolvedFor / ensErrorFor), and ensStatus below
  // is derived by comparing that key against the live recipient text rather
  // than stored as its own state - so editing the recipient automatically
  // invalidates a stale result without any synchronous setState in the
  // effect body itself (every setState below happens inside the async
  // timer callback, same pattern as the ownerAddress effect above).
  const [ensResolvedFor, setEnsResolvedFor] = useState<string | null>(null);
  const [ensResolvedAddress, setEnsResolvedAddress] = useState<string | null>(
    null,
  );
  const [ensErrorFor, setEnsErrorFor] = useState<string | null>(null);
  const [ensError, setEnsError] = useState<string | null>(null);

  const trimmedRecipient = recipient.trim();
  const isEnsLike = looksLikeEnsName(trimmedRecipient);
  const ensStatus: EnsStatus = !isEnsLike
    ? "idle"
    : ensResolvedFor === trimmedRecipient && ensResolvedAddress
      ? "resolved"
      : ensErrorFor === trimmedRecipient && ensError
        ? "error"
        : "loading";

  // Debounced ENS resolution against Ethereum mainnet (Robinhood Chain has
  // no ENS deployment of its own, see app/api/ens/resolve/route.ts).
  useEffect(() => {
    if (!isEnsLike) return;
    if (
      ensResolvedFor === trimmedRecipient ||
      ensErrorFor === trimmedRecipient
    ) {
      return; // already have a fresh result for this exact text
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/ens/resolve?name=${encodeURIComponent(trimmedRecipient)}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || !body.address) {
          setEnsErrorFor(trimmedRecipient);
          setEnsError("That ENS name doesn't resolve to an address.");
          return;
        }
        setEnsResolvedFor(trimmedRecipient);
        setEnsResolvedAddress(body.address);
      } catch {
        if (!cancelled) {
          setEnsErrorFor(trimmedRecipient);
          setEnsError("Unable to resolve that ENS name right now.");
        }
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedRecipient, isEnsLike, ensResolvedFor, ensErrorFor]);

  const isOwner =
    connectedAddress && ownerAddress
      ? connectedAddress.toLowerCase() === ownerAddress.toLowerCase()
      : false;

  async function handleActivate() {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const account = await connectWallet();
      if (account.toLowerCase() !== ownerAddress?.toLowerCase()) {
        throw new Error(
          "Connected wallet doesn't currently own this anon - switch wallets and try again.",
        );
      }
      setStatus("Confirm the activation in your wallet...");
      const hash = await sendTransaction(
        account,
        buildCreateAccountTx(tokenId),
      );
      setTxHash(hash);
      setStatus("Activating - waiting for confirmation on-chain...");
      const confirmed = await waitForActivation(tbaAddress);
      if (!confirmed) {
        throw new Error(
          "Transaction sent, but activation isn't confirmed yet - check the explorer link and refresh in a bit.",
        );
      }
      setActivated(true);
      setStatus("Wallet activated - you can now send from it below.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const account = await connectWallet();
      if (account.toLowerCase() !== ownerAddress?.toLowerCase()) {
        throw new Error(
          "Connected wallet doesn't currently own this anon - switch wallets and try again.",
        );
      }
      let targetAddress: string;
      if (isAddress(trimmedRecipient)) {
        targetAddress = trimmedRecipient;
      } else if (ensStatus === "resolved" && ensResolvedAddress) {
        // Always the freshly-resolved address, never the raw ENS string -
        // ensStatus/ensResolvedAddress are derived against the live
        // recipient text, so this can't be stale from a previous name.
        targetAddress = ensResolvedAddress;
      } else if (ensStatus === "loading") {
        throw new Error(
          "Still resolving that ENS name - wait a moment and try again.",
        );
      } else {
        throw new Error("Enter a valid recipient address or ENS name.");
      }

      const asset = assets.find((a) => a.key === assetKey);
      if (!asset) throw new Error("Pick an asset to send.");

      const amountRaw = parseUnits(amount || "0", asset.decimals);
      if (amountRaw <= BigInt(0)) {
        throw new Error("Enter an amount greater than zero.");
      }
      if (amountRaw > BigInt(asset.balanceRaw)) {
        throw new Error("Amount exceeds this wallet's balance.");
      }

      const tx =
        asset.key === "eth"
          ? buildSendEthTx(tbaAddress, targetAddress, amountRaw)
          : buildSendTokenTx(tbaAddress, asset.key, targetAddress, amountRaw);

      setStatus("Confirm the send in your wallet...");
      const hash = await sendTransaction(account, tx);
      setTxHash(hash);
      setStatus("Sent - waiting for confirmation on-chain.");
      setAmount("");
      setRecipient("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hc-box p-4 flex flex-col gap-3">
      <div className="hc-thread-meta text-xs">wallet actions</div>

      {!connectedAddress && (
        <p className="hc-thread-meta text-sm">
          Connect the wallet that owns this anon to activate or send from here.
        </p>
      )}

      {connectedAddress && ownerAddress && !isOwner && (
        <p className="hc-thread-meta text-sm">
          Connected wallet doesn&apos;t own anon #{tokenId} right now - connect
          the wallet that does to activate or send from here.
        </p>
      )}

      {connectedAddress && isOwner && !activated && (
        <div className="flex flex-col gap-2">
          <p className="hc-thread-meta text-sm">
            This wallet can already receive assets. Activating it (one-time,
            your gas) lets it send/spend too.
          </p>
          <button
            type="button"
            className="hc-button self-start"
            disabled={busy}
            onClick={handleActivate}
          >
            {busy ? "Working..." : "Activate this wallet"}
          </button>
        </div>
      )}

      {connectedAddress && isOwner && activated && (
        <form className="flex flex-col gap-2" onSubmit={handleSend}>
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              className="hc-form-input"
              value={assetKey}
              onChange={(e) => setAssetKey(e.target.value)}
            >
              {assets.map((asset) => (
                <option key={asset.key} value={asset.key}>
                  {asset.label}
                </option>
              ))}
            </select>
            <input
              className="hc-form-input flex-1"
              placeholder="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <input
            className="hc-form-input"
            placeholder="recipient address (0x...) or ENS name"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          {ensStatus === "loading" && (
            <p className="hc-thread-meta text-xs">resolving ENS name...</p>
          )}
          {ensStatus === "resolved" && ensResolvedAddress && (
            <p
              className="hc-thread-meta text-xs font-mono"
              style={{ color: "var(--hc-greentext)" }}
            >
              → {truncateAddress(ensResolvedAddress)}
            </p>
          )}
          {ensStatus === "error" && ensError && (
            <p className="text-xs" style={{ color: "#a12b2b" }}>
              {ensError}
            </p>
          )}
          <button
            type="submit"
            className="hc-button self-start"
            disabled={busy || ensStatus === "loading"}
          >
            {busy ? "Working..." : "Send"}
          </button>
        </form>
      )}

      {status && (
        <p
          className="hc-thread-meta text-xs"
          style={{ color: "var(--hc-greentext)" }}
        >
          {status}
        </p>
      )}
      {error && (
        <p className="text-xs" style={{ color: "#a12b2b" }}>
          {error}
        </p>
      )}
      {txHash && (
        <a
          href={`${BLOCK_EXPLORER_URL}/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hc-link text-xs font-mono break-all"
        >
          view transaction
        </a>
      )}
    </div>
  );
}
