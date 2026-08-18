"use client";

// Wallet connect + active identity, lives in the header, top-right of nav -
// where every other dApp puts it - instead of inline in the home page's
// body. Previously "Connect Wallet" only appeared after scrolling past the
// info box/ad banner on "/", and once connected the full untruncated
// address sat in the page body as its own line ("connected: 0xF138...ddE12"),
// pushing everything else down and not visible from any other page.
//
// Once a persona is active, this widget shows THAT anon (pfp + "Anon #N")
// instead of the raw address - direct feedback that "who am I posting as"
// was buried behind a collapsed section only visible on the home page.
// Design intentionally follows the Discord/Gmail account-switcher pattern:
// a persistent badge for the current identity (recognition over recall),
// a short quick-switch list in the dropdown for the common case, and a
// link to the home page's full token grid for anyone with a big
// collection who needs to browse/search - not a second copy of that grid
// crammed into a small popover, which gets unusable past a handful of
// items.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { connectWallet, disconnectWallet } from "@/lib/wallet";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { useHasNewActivity } from "@/lib/useHasNewActivity";
import { useActivePersona } from "@/lib/usePersona";
import { BLOCK_EXPLORER_URL } from "@/lib/chain";
import type { TokenMetadata } from "@/lib/chain";

const QUICK_SWITCH_LIMIT = 5;

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function fetchTokenMetadata(
  tokenId: string,
): Promise<TokenMetadata | null> {
  try {
    const res = await fetch(`/api/token/${tokenId}`);
    if (!res.ok) return null;
    return (await res.json()) as TokenMetadata;
  } catch {
    return null;
  }
}

export function WalletHeaderWidget() {
  const address = useWalletAddress();
  const { persona, switchPersona } = useActivePersona();
  const [connecting, setConnecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { hasNew, markSeen } = useHasNewActivity(address);

  const isActive =
    !!persona &&
    !!address &&
    persona.address.toLowerCase() === address.toLowerCase();

  const [activeMeta, setActiveMeta] = useState<TokenMetadata | null>(null);
  const [otherTokenIds, setOtherTokenIds] = useState<string[]>([]);
  const [otherMeta, setOtherMeta] = useState<
    Record<string, TokenMetadata | null>
  >({});

  // Active anon's own pfp for the badge - refetches whenever the active
  // token changes, not on every render. No setState on the "inactive"
  // path - JSX already gates rendering on `isActive`, so stale metadata
  // left over from a previous active token simply never renders instead
  // of needing an explicit synchronous clear.
  useEffect(() => {
    if (!isActive || !persona) return;
    let cancelled = false;
    fetchTokenMetadata(persona.tokenId).then((meta) => {
      if (!cancelled) setActiveMeta(meta);
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, persona]);

  // Quick-switch candidates - cheap reverse-index lookup (lib/store.ts's
  // listMyClaimedTokens), not the full on-chain wallet scan HomeClient
  // does. Fetched once per connected address, not per dropdown-open, so
  // the menu feels instant when clicked. Same no-setState-on-the-early-
  // path reasoning as above - rendering this list already requires
  // `address` to exist.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetch(`/api/persona/mine?${new URLSearchParams({ address })}`)
      .then((res) => (res.ok ? res.json() : { tokenIds: [] }))
      .then((body) => {
        if (cancelled) return;
        const ids = (body.tokenIds as string[]) ?? [];
        setOtherTokenIds(
          ids
            .filter((id) => id !== persona?.tokenId)
            .slice(0, QUICK_SWITCH_LIMIT),
        );
      })
      .catch(() => {
        if (!cancelled) setOtherTokenIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [address, persona?.tokenId]);

  // Thumbnails for the quick-switch list - only for the (small, capped)
  // set of other token IDs, not the whole collection.
  useEffect(() => {
    if (otherTokenIds.length === 0) return;
    let cancelled = false;
    Promise.all(
      otherTokenIds.map(
        async (id) => [id, await fetchTokenMetadata(id)] as const,
      ),
    ).then((entries) => {
      if (cancelled) return;
      setOtherMeta(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [otherTokenIds]);

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

  const handleSwitch = useCallback(
    async (tokenId: string) => {
      setSwitchError(null);
      setSwitching(tokenId);
      try {
        await switchPersona(tokenId);
        setMenuOpen(false);
      } catch (err) {
        setSwitchError(
          err instanceof Error ? err.message : "Unable to switch anon.",
        );
      } finally {
        setSwitching(null);
      }
    },
    [switchPersona],
  );

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
        {isActive && activeMeta ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeMeta.image}
              alt=""
              className="hc-wallet-pill-avatar"
            />
            Anon #{persona.tokenId}
          </>
        ) : (
          truncateAddress(address)
        )}
        {hasNew && <span className="hc-wallet-badge" aria-hidden="true" />}
      </button>
      {menuOpen && (
        <div className="hc-wallet-menu">
          {isActive && (
            <div className="hc-wallet-menu-active">
              posting as Anon #{persona.tokenId}
            </div>
          )}
          {otherTokenIds.length > 0 && (
            <>
              <div className="hc-wallet-menu-label">switch anon</div>
              {otherTokenIds.map((tokenId) => (
                <button
                  key={tokenId}
                  onClick={() => handleSwitch(tokenId)}
                  disabled={switching !== null}
                  className="hc-wallet-menu-item hc-wallet-menu-item-switch"
                >
                  {otherMeta[tokenId]?.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={otherMeta[tokenId]!.image}
                      alt=""
                      className="hc-wallet-pill-avatar"
                    />
                  )}
                  {switching === tokenId
                    ? "Sign in wallet..."
                    : `Anon #${tokenId}`}
                </button>
              ))}
            </>
          )}
          {switchError && (
            <div className="hc-wallet-menu-error">{switchError}</div>
          )}
          <Link
            href="/"
            className="hc-wallet-menu-item"
            onClick={() => setMenuOpen(false)}
          >
            Browse all your anons →
          </Link>
          <div className="hc-wallet-menu-divider" />
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
