"use client";

// Minimal connect/disconnect pill - trimmed version of the parent app's
// WalletHeaderWidget (this app has no persona/avatar system to render, just
// needs an address for reads and a signer for breeding txs).
import { useEffect, useState } from "react";
import {
  connectWallet,
  disconnectWallet,
  onAccountsChanged,
} from "@/lib/wallet";

function short(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletHeaderWidget() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onAccountsChanged((accounts) => {
      setAddress(accounts[0] ?? null);
    });
  }, []);

  async function handleConnect() {
    setError(null);
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setAddress(addr);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect.");
    } finally {
      setConnecting(false);
    }
  }

  if (address) {
    return (
      <button
        className="hc-wallet-connect-btn"
        onClick={() => disconnectWallet()}
        title="Click to disconnect"
      >
        {short(address)}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        className="hc-wallet-connect-btn"
        onClick={handleConnect}
        disabled={connecting}
      >
        {connecting ? "Connecting..." : "Connect Wallet"}
      </button>
      {error && (
        <span className="text-[0.65rem]" style={{ color: "#fdeaea" }}>
          {error}
        </span>
      )}
    </div>
  );
}
