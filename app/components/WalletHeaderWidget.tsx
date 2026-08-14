"use client";

// Wallet connect lives in the header, top-right of nav - where every other
// dApp puts it - instead of inline in the home page's body. Previously
// "Connect Wallet" only appeared after scrolling past the info box/ad
// banner on "/", and once connected the full untruncated address sat in
// the page body as its own line ("connected: 0xF138...ddE12"), pushing
// everything else down and not visible from any other page.
import { useCallback, useState } from "react";
import { connectWallet } from "@/lib/wallet";
import { useWalletAddress } from "@/lib/useWalletAddress";

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletHeaderWidget() {
  const address = useWalletAddress();
  const [connecting, setConnecting] = useState(false);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      await connectWallet();
    } catch {
      // The AppKit modal itself surfaces why (rejected, no provider, etc);
      // nothing useful to show in this small a widget beyond resetting the
      // button so the user can just try again.
    } finally {
      setConnecting(false);
    }
  }, []);

  if (address) {
    return (
      <span className="hc-wallet-pill" title={address}>
        {truncateAddress(address)}
      </span>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={connecting}
      className="hc-wallet-connect-btn"
    >
      {connecting ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
