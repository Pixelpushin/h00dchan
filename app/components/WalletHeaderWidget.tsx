"use client";

// Wallet connect + active identity, lives in the header, top-right of nav -
// where every other dApp puts it - instead of inline in the home page's
// body. Previously "Connect Wallet" only appeared after scrolling past the
// info box/ad banner on "/", and once connected the full untruncated
// address sat in the page body as its own line ("connected: 0xF138...ddE12"),
// pushing everything else down and not visible from any other page.
//
// Panel design modeled directly on Google's own account switcher (shown
// live as a reference): round avatar-only trigger button (no truncated
// text at all once an identity is active), a centered panel below it with
// a large avatar + name up top, then a collapsed "show other accounts"
// toggle that expands into the switch list - not a flat list of everything
// crammed into the dropdown by default. Recognition over recall (the
// active identity is always visible, nothing to hunt for) plus
// progressive disclosure (the full list is one extra click away, not
// forced onto everyone who only has one or two anons).
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { connectWallet, disconnectWallet } from "@/lib/wallet";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { useHasNewActivity } from "@/lib/useHasNewActivity";
import { useActivePersona } from "@/lib/usePersona";
import { BLOCK_EXPLORER_URL } from "@/lib/chain";
import type { TokenMetadata } from "@/lib/chain";
import { PostImage } from "@/app/components/PostImage";
import { GearIcon } from "@/app/components/Icons";

const QUICK_SWITCH_LIMIT = 8;
const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/h00dchan";

// IPFS gateways are observably flaky per-request (documented throughout
// this codebase) - a plain <img src={metadata.image}> can and did fail
// live in production while a second <img> using the exact same URL
// elsewhere on the same page succeeded, because each request independently
// hits whichever gateway happens to be slow/down at that moment. PostImage
// is this repo's established fix (cycles through backup gateways on
// error) - every other avatar/thumbnail on the site already goes through
// it; these were the one place that didn't.
function rawImageUriFrom(metadata: TokenMetadata): string {
  return typeof metadata.raw.image === "string" ? metadata.raw.image : "";
}

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
  const router = useRouter();
  const address = useWalletAddress();
  const { persona, switchPersona } = useActivePersona();
  const [connecting, setConnecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
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

  // Active anon's own pfp - refetches whenever the active token changes.
  // Deliberately NOT gating the "Anon #N" text on this having loaded (see
  // JSX below) - an earlier version did, which meant a slow/failed image
  // fetch silently hid the whole identity display and fell back to the
  // raw address, making the feature look like it wasn't there at all.
  // The name always shows once isActive is true; the avatar is a bonus
  // once it resolves.
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

  // "Admin" menu item visibility only - NOT the real gate. The actual
  // admin routes independently require a signed message from a
  // whitelisted address (lib/adminAuth.ts); this just decides whether to
  // show the link at all, via a cheap public endpoint that only ever
  // answers true/false for the one address already in scope, never
  // returns the whitelist itself.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    // No explicit setIsAdmin(false) here for the !address case - same
    // set-state-in-effect fix already applied twice elsewhere in this
    // component. A stale `true` left over from a previous connected
    // address can never actually render: the whole dropdown panel this
    // menu item lives in is itself gated behind `if (!address)` returning
    // the "Connect Wallet" button earlier in this same render, before
    // isAdmin is ever read.
    if (!address) return;
    let cancelled = false;
    fetch(`/api/admin/is-admin?${new URLSearchParams({ address })}`)
      .then((res) => (res.ok ? res.json() : { isAdmin: false }))
      .then((body) => {
        if (!cancelled) setIsAdmin(Boolean(body.isAdmin));
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Does this connected address hold ANY HOODCHAN at all, regardless of
  // claimed/activated status - the trigger button's whole state machine
  // (gear icon "you don't hold one" vs. bright "Activate") hinges on this,
  // not just on whether a persona happens to be active. Same on-chain
  // wallet-token scan /collection uses (lib/chain.ts's
  // fetchWalletTokensOnChain via app/api/wallet-tokens), just reading the
  // returned count, not fetching per-token art/metadata - lighter than
  // what that page does with the same response. null while loading (or
  // once no address at all) - the button defaults to the "Activate"
  // urgent state during that brief window rather than "no NFT," since
  // most connected wallets in this holder-only app DO hold one, and
  // flashing the wrong state for the common case is worse than a
  // half-second of an optimistic default.
  const [ownedTokenCount, setOwnedTokenCount] = useState<number | null>(null);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetch(`/api/wallet-tokens?${new URLSearchParams({ address })}`)
      .then((res) => (res.ok ? res.json() : { tokenIds: [] }))
      .then((body) => {
        if (!cancelled) {
          setOwnedTokenCount(
            Array.isArray(body.tokenIds) ? body.tokenIds.length : 0,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setOwnedTokenCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);
  const hasNoTokens = ownedTokenCount === 0;

  // Quick-switch candidates - cheap reverse-index lookup (lib/store.ts's
  // listMyClaimedTokens), not the full on-chain wallet scan HomeClient
  // does. Fetched once per connected address, not per dropdown-open, so
  // the panel feels instant when opened.
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

  // The claim/activate token grid lives on its own page (app/collection/
  // page.tsx) now, not embedded in the home page body - this is that
  // page's one entry point from the header.
  const handleBrowseAll = useCallback(() => {
    setMenuOpen(false);
    router.push("/collection");
  }, [router]);

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
        className={
          isActive
            ? "hc-wallet-avatar-btn"
            : hasNoTokens
              ? "hc-wallet-pill hc-wallet-pill-neutral"
              : "hc-wallet-pill hc-wallet-pill-urgent"
        }
        title={
          hasNew
            ? "New reply on one of your threads"
            : isActive
              ? `Anon #${persona.tokenId}`
              : hasNoTokens
                ? "No HOODCHAN in this wallet - buy one on OpenSea"
                : "No anon activated yet - click to activate"
        }
        aria-expanded={menuOpen}
      >
        {isActive ? (
          activeMeta?.image ? (
            <PostImage
              rawImageUri={rawImageUriFrom(activeMeta)}
              fallbackSrc={activeMeta.image}
              alt={`Anon #${persona.tokenId}`}
              className="hc-wallet-avatar-img"
            />
          ) : (
            <span className="hc-wallet-avatar-fallback">
              #{persona.tokenId}
            </span>
          )
        ) : hasNoTokens ? (
          // Not an action this site can resolve (buying happens on
          // OpenSea) - a neutral status indicator, not an urgent CTA.
          <GearIcon className="h-3.5 w-3.5" />
        ) : (
          // Truncated address used to sit here - reported live as
          // confusing: nothing about "0xE0A7...eB409" tells a connected-
          // but-not-activated visitor they still have a step left. The
          // trigger button itself now says so, not just the dropdown
          // underneath it - and while ownedTokenCount is still loading,
          // this optimistic default is shown rather than the gear (see
          // that state's own comment for why).
          "Activate"
        )}
        {hasNew && <span className="hc-wallet-badge" aria-hidden="true" />}
      </button>
      {menuOpen && (
        <div className="hc-wallet-panel">
          <div className="hc-wallet-panel-email">
            {truncateAddress(address)}
          </div>

          {isActive && (
            <div className="hc-wallet-panel-identity">
              {activeMeta?.image ? (
                <PostImage
                  rawImageUri={rawImageUriFrom(activeMeta)}
                  fallbackSrc={activeMeta.image}
                  alt={`Anon #${persona.tokenId}`}
                  className="hc-wallet-panel-avatar"
                />
              ) : (
                <div className="hc-wallet-panel-avatar hc-wallet-avatar-fallback">
                  #{persona.tokenId}
                </div>
              )}
              <div className="hc-wallet-panel-name">
                Anon #{persona.tokenId}
              </div>
              <a
                href={`/wallet/${persona.tokenId}`}
                className="hc-wallet-panel-manage"
                onClick={() => setMenuOpen(false)}
              >
                View full profile
              </a>
            </div>
          )}

          {!isActive && hasNoTokens && (
            // Connected wallet genuinely holds zero HOODCHAN - nothing on
            // this site can resolve that, so the dropdown's job here is
            // just to hand off to OpenSea cleanly, branded so it's obvious
            // where it goes before clicking.
            <div className="hc-wallet-panel-identity">
              <p className="hc-thread-meta text-xs text-center mb-2">
                No HOODCHAN in this wallet
              </p>
              <a
                href={OPENSEA_COLLECTION_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hc-button-opensea text-sm w-full"
                onClick={() => setMenuOpen(false)}
              >
                Buy on OpenSea
              </a>
            </div>
          )}

          {!isActive && !hasNoTokens && (
            // Connected, holds at least one HOODCHAN, hasn't activated
            // any of them yet - reported live as a real dead end: no
            // avatar to show, and "Browse all your anons ->" further down
            // read as just another menu item, easy to miss. This is the
            // actual next step for a real holder, so it gets its own
            // real button, not a text link buried in the list. Also the
            // optimistic default while ownedTokenCount is still loading
            // (see that state's own comment).
            <div className="hc-wallet-panel-identity">
              <p className="hc-thread-meta text-xs text-center mb-2">
                No anon activated yet
              </p>
              <a
                href="/collection"
                className="hc-button-urgent text-sm w-full"
                onClick={() => setMenuOpen(false)}
              >
                Activate Collection
              </a>
            </div>
          )}

          {otherTokenIds.length > 0 && (
            <div className="hc-wallet-panel-others">
              <button
                onClick={() => setShowOthers((v) => !v)}
                className="hc-wallet-panel-toggle"
              >
                <span>
                  {showOthers ? "Hide" : "Show"} other anons (
                  {otherTokenIds.length})
                </span>
                <span aria-hidden="true">{showOthers ? "▲" : "▼"}</span>
              </button>
              {showOthers && (
                <div className="hc-wallet-panel-others-list">
                  {otherTokenIds.map((tokenId) => (
                    <button
                      key={tokenId}
                      onClick={() => handleSwitch(tokenId)}
                      disabled={switching !== null}
                      className="hc-wallet-menu-item hc-wallet-menu-item-switch"
                    >
                      {otherMeta[tokenId]?.image ? (
                        <PostImage
                          rawImageUri={rawImageUriFrom(otherMeta[tokenId]!)}
                          fallbackSrc={otherMeta[tokenId]!.image}
                          alt=""
                          className="hc-wallet-pill-avatar"
                        />
                      ) : (
                        <span className="hc-wallet-pill-avatar hc-wallet-avatar-fallback-sm" />
                      )}
                      {switching === tokenId
                        ? "Sign in wallet..."
                        : `Anon #${tokenId}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {switchError && (
            <div className="hc-wallet-menu-error">{switchError}</div>
          )}

          {/* Always present regardless of state, on purpose - the
              constant fallback path to /collection, same place in the
              dropdown every time, even when a state-specific button
              above already covers it too (isActive has no other link to
              it, so this is the ONLY one there - consistency of "it's
              always right here" wins over trimming a little redundancy
              in the other two states). */}
          <button onClick={handleBrowseAll} className="hc-wallet-menu-item">
            Collection →
          </button>
          {isAdmin && (
            <a
              href="/admin"
              className="hc-wallet-menu-item"
              onClick={() => setMenuOpen(false)}
            >
              Admin
            </a>
          )}
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
