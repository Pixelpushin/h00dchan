"use client";

// Wallet connect lives in the header, top-right of nav - where every other
// dApp puts it - instead of inline in the home page's body. Previously
// "Connect Wallet" only appeared after scrolling past the info box/ad
// banner on "/", and once connected the full untruncated address sat in
// the page body as its own line ("connected: 0xF138...ddE12"), pushing
// everything else down and not visible from any other page. Connected
// state is a real clickable button (not just a static label) opening a
// small menu - copy address, view on the block explorer, disconnect -
// same as any wallet widget in a real dApp header.
import { useCallback, useEffect, useRef, useState } from "react";
import { connectWallet, disconnectWallet } from "@/lib/wallet";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { useHasNewActivity } from "@/lib/useHasNewActivity";
import { BLOCK_EXPLORER_URL } from "@/lib/chain";

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletHeaderWidget() {
  const address = useWalletAddress();
  const [connecting, setConnecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { hasNew, markSeen } = useHasNewActivity(address);

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

  const handleCopy = useCallback(() => {
    if (!address) return;
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [address]);

  const handleDisconnect = useCallback(() => {
    setMenuOpen(false);
    disconnectWallet();
  }, []);

  // Click-outside-to-close - the standard behavior for this kind of small
  // header dropdown, and without it the menu would only ever close via the
  // menu's own actions.
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  if (!address) {
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

  const explorerUrl = `${BLOCK_EXPLORER_URL}/address/${address}`;

  return (
    <div className="hc-wallet-widget" ref={rootRef}>
      <button
        onClick={() =>
          setMenuOpen((open) => {
            const next = !open;
            if (next) markSeen();
            return next;
          })
        }
        className="hc-wallet-pill"
        title={hasNew ? "New reply on one of your threads" : address}
        aria-expanded={menuOpen}
      >
        {truncateAddress(address)}
        {hasNew && <span className="hc-wallet-badge" aria-hidden="true" />}
      </button>
      {menuOpen && (
        <div className="hc-wallet-menu">
          <button onClick={handleCopy} className="hc-wallet-menu-item">
            {copied ? "Copied!" : "Copy address"}
          </button>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hc-wallet-menu-item"
            onClick={() => setMenuOpen(false)}
          >
            View on explorer
          </a>
          <button
            onClick={handleDisconnect}
            className="hc-wallet-menu-item hc-wallet-menu-item-danger"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
