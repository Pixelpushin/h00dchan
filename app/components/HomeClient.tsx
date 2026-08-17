"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { onAccountsChanged, signMessage } from "@/lib/wallet";
import { WhatIsHoodchan } from "@/app/components/WhatIsHoodchan";
import { AdBanner, type PaidAd } from "@/app/components/AdBanner";
import { RentAdSpaceButton } from "@/app/components/RentAdSpaceButton";
import { useActivePersona } from "@/lib/usePersona";

const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/h00dchan";
import { ipfsGatewayUrls, type TokenMetadata } from "@/lib/chain";
import {
  buildAuthMessage,
  buildBatchAuthMessage,
  MAX_BATCH_CLAIM_SIZE,
} from "@/lib/persona";
import {
  readWalletRenderCache,
  writeWalletRenderCache,
} from "@/lib/walletCache";

type ClaimStage = "preparing" | "signing" | "confirming" | null;

interface TbaInfo {
  address: string;
  activated: boolean;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// GET /api/claim?tokenId=X - public, read-only real claimed status (see
// app/api/claim/route.ts). Separate from useActivePersona: that tracks
// "which one anon am I currently posting as" (a single session-scoped
// slot), this tracks "has this specific token actually been silenced
// server-side" - a token can be claimed without being your *current*
// posting identity (e.g. you claimed it in an earlier session, or claimed
// a second token afterward).
async function fetchClaimedStatus(tokenId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/claim?tokenId=${tokenId}`);
    if (!res.ok) return false;
    const data = (await res.json()) as { claimed?: boolean };
    return data.claimed === true;
  } catch {
    return false;
  }
}

type LoadState = "idle" | "loading-tokens" | "ready" | "error";

// Metadata is resolved through our own API route (app/api/token/[tokenId])
// rather than fetchTokenMetadata() directly, because that function's IPFS
// gateway fetches proved CORS-flaky when called from the browser - see the
// route's own comment for what was actually observed.
async function fetchTokenMetadataViaApi(
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

// Cycles through the remaining IPFS gateways on load failure instead of
// giving up after the first one - individual gateways are observably flaky
// even when the underlying content is available.
function TokenImage({ token }: { token: TokenMetadata }) {
  const rawImageUri =
    typeof token.raw.image === "string" ? token.raw.image : "";
  const candidates = rawImageUri ? ipfsGatewayUrls(rawImageUri) : [];
  const [attempt, setAttempt] = useState(0);
  const src = candidates[attempt] ?? token.image;

  if (!src) {
    return (
      <div
        className="w-full aspect-square"
        style={{ background: "var(--hc-box-alt)" }}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={token.name}
      className="w-full aspect-square object-cover"
      onError={() => {
        setAttempt((current) =>
          current + 1 < candidates.length ? current + 1 : current,
        );
      }}
    />
  );
}

// `popularThreads` is a Server Component (see app/page.tsx) passed down as
// children - the officially-supported way to mix server-rendered content
// into a client component's tree without turning the data fetch itself
// into a client fetch. Only shown while logged out, matching the ask: a
// first-time visitor with no wallet ready should see real board content
// instead of nothing but a button, same as 4chan's own front page leads
// with a "Popular Threads" panel.
export default function HomeClient({
  popularThreads,
  paidAds,
}: {
  popularThreads: ReactNode;
  paidAds: PaidAd[];
}) {
  const router = useRouter();
  const { persona, savePersona } = useActivePersona();
  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [wallets, setWallets] = useState<Record<string, TbaInfo>>({});
  const [claimedTokens, setClaimedTokens] = useState<Record<string, boolean>>(
    {},
  );
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimStage, setClaimStage] = useState<ClaimStage>(null);
  const [bulkActivating, setBulkActivating] = useState(false);
  const [bulkStage, setBulkStage] = useState<"signing" | "confirming" | null>(
    null,
  );
  // Only set (and only shown) when a holder has more unclaimed tokens than
  // MAX_BATCH_CLAIM_SIZE - one signature can only ever authorize up to that
  // many tokens (see lib/persona.ts), so a bigger wallet needs one
  // signature per group. A real holder with 50+ tokens hit this live: the
  // batch endpoint correctly rejected the oversized request
  // (INVALID_INPUT, "Too many tokens in one batch"), but the client never
  // split into groups to begin with, so "Activate All" just hard-failed
  // for anyone above the cap.
  const [bulkProgress, setBulkProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  // Wallet-token discovery (log scan + per-candidate ownerOf checks, each
  // now retried once - see lib/chain.ts's fetchWalletTokensOnChain) and
  // TBA lookups (registry account() + getCode()) both go through
  // /api/wallet-tokens, server-to-server, instead of the browser calling
  // Robinhood Chain's RPC directly - confirmed live (a real holder's
  // browser console) that at high request volume that RPC sometimes
  // returns a malformed CORS header, which every browser correctly
  // refuses; server-to-server was never subject to that restriction.
  //
  // Always a full scan, every time - this used to be incremental (a
  // second cache remembering the last-scanned block + known token IDs, so
  // a repeat visit only asked the chain for what changed), which hit the
  // same root problem three separate times in production: an incremental
  // result can only ever build on a cache that's already correct, and the
  // self-heal heuristics needed to keep getting broader every time a new
  // way for that cache to be quietly wrong turned up (poisoned-empty,
  // then "smaller than before," ...). Removed the whole category instead
  // of patching it a fourth time. What actually solves the UX problem
  // incremental scanning was originally for is readWalletRenderCache
  // below: it paints the last-known-good grid instantly, so the fetch in
  // this function can just always be the slower-but-reliable full answer
  // running silently in the background, with nothing for the user to
  // wait on either way.
  const loadTokens = useCallback(async (owner: string) => {
    setError(null);
    const renderCache = readWalletRenderCache(owner);
    if (renderCache) {
      setTokens(renderCache.tokens as TokenMetadata[]);
      setWallets(renderCache.wallets as Record<string, TbaInfo>);
      setClaimedTokens(renderCache.claimedTokens);
      setState("ready");
    } else {
      setState("loading-tokens");
      setWallets({});
      setClaimedTokens({});
    }
    try {
      // Always a full scan now - no fromBlock/knownTokenIds. This used to
      // be incremental (cache the last scanned block + known token IDs,
      // only ask the chain for what changed since), which hit the same
      // root problem three times in a row: an incremental result can only
      // ever build on a cache that's already correct, and self-heal
      // heuristics (retry on empty, then retry on "smaller than cached")
      // kept needing to get broader every time a new way for the cache to
      // be quietly wrong turned up. The instant-paint render cache above
      // (readWalletRenderCache) is what actually solved the UX problem
      // incremental scanning was originally for - the user already sees
      // their last-known-good wallet immediately, so this background
      // fetch can just always be the reliable, from-scratch answer instead
      // of a faster-but-fragile shortcut. eth_getLogs itself is fast for a
      // single address's Transfer history (confirmed live, ~300ms) - the
      // per-candidate ownerOf re-verification below (now retried once per
      // candidate) was always the real cost either way, incremental or not.
      const res = await fetch(
        `/api/wallet-tokens?${new URLSearchParams({ address: owner })}`,
      );
      const walletBody = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          typeof walletBody?.error === "string"
            ? walletBody.error
            : `Unable to load tokens (${res.status}).`,
        );
      }

      const tokenIds: string[] = walletBody.tokenIds;
      const walletMap: Record<string, TbaInfo> = walletBody.wallets ?? {};

      const [metadata, claimedFlags] = await Promise.all([
        Promise.all(tokenIds.map((id) => fetchTokenMetadataViaApi(id))),
        Promise.all(tokenIds.map((id) => fetchClaimedStatus(id))),
      ]);
      const resolved = metadata
        .filter((m): m is TokenMetadata => m !== null)
        .sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
      setTokens(resolved);
      const claimedMap: Record<string, boolean> = {};
      tokenIds.forEach((id, i) => {
        if (claimedFlags[i]) claimedMap[id] = true;
      });
      setWallets(walletMap);
      setClaimedTokens(claimedMap);
      setState("ready");
      writeWalletRenderCache(owner, {
        tokens: resolved,
        wallets: walletMap,
        claimedTokens: claimedMap,
      });
    } catch (err) {
      // If a render cache already painted something, a failed background
      // refresh shouldn't blank the page out from under it - stale data
      // the user already saw is better than replacing it with an error
      // screen. Only show the hard error state when there was nothing on
      // screen to begin with.
      if (renderCache) {
        console.error("Background wallet refresh failed", err);
        return;
      }
      setError(
        err instanceof Error ? err.message : "Unable to load HOODCHAN tokens.",
      );
      setState("error");
    }
  }, []);

  // Signs the "posting authorization" message for one token, then actually
  // tells the server to silence that token's AI (POST /api/claim) before
  // switching the active "posting as" identity (useActivePersona -
  // sessionStorage-backed, a single slot: you can only post as one anon at
  // a time, same as a real imageboard trip). Previously this only signed
  // and stored the persona locally - nothing server-side ever changed
  // until you separately posted a thread/reply, so a plain "sign" did NOT
  // silence the clanker or move the site-wide progress bar despite the
  // site's own copy promising it would, and activating a second token
  // silently looked like it un-activated the first (it didn't - the first
  // was never actually marked claimed to begin with). claimedTokens now
  // tracks real per-token server state independently of which one is the
  // current active persona, so multiple tokens can be (and stay) claimed
  // at once.
  // Returns whether the claim actually succeeded - handleActivateAll below
  // uses this to stop the batch on the first failure (most likely the user
  // rejecting a wallet prompt) instead of firing several more signature
  // requests in a row regardless.
  const handleClaim = useCallback(
    async (token: TokenMetadata): Promise<boolean> => {
      if (!address) return false;
      setClaimingId(token.tokenId);
      setClaimStage("preparing");
      setError(null);
      try {
        const issuedAt = new Date().toISOString();
        const message = buildAuthMessage(token.tokenId, address, issuedAt);
        setClaimStage("signing");
        const signature = await signMessage(address, message);
        const persona = {
          tokenId: token.tokenId,
          address,
          signature,
          issuedAt,
        };

        setClaimStage("confirming");
        const res = await fetch("/api/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(persona),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : `Unable to activate this anon (${res.status}).`,
          );
        }

        setClaimedTokens((current) => ({ ...current, [token.tokenId]: true }));
        savePersona(persona);
        return true;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to sign the claim message.",
        );
        return false;
      } finally {
        setClaimingId(null);
        setClaimStage(null);
      }
    },
    [address, savePersona],
  );

  // One signature covers every pending token (lib/persona.ts's
  // buildBatchAuthMessage) instead of one wallet prompt per token -
  // claiming was never an on-chain transaction to begin with (no gas), so
  // "batching" it just means building one message instead of N and
  // sending one request to /api/claim/batch. The signature itself either
  // succeeds or fails as a whole (one prompt, one user decision); once
  // it's signed, ownership is still re-checked per token server-side, so a
  // token that sold in the meantime is reported back as failed rather than
  // silently succeeding or blocking the rest of the batch.
  const handleActivateAll = useCallback(async () => {
    const pending = tokens.filter((t) => !claimedTokens[t.tokenId]);
    if (!address || pending.length === 0) return;
    setBulkActivating(true);
    setError(null);

    // One signature only ever authorizes up to MAX_BATCH_CLAIM_SIZE tokens
    // (the server hard-rejects anything larger - INVALID_INPUT, "Too many
    // tokens in one batch"). A holder past that count needs one signature
    // per group instead of one signature total - real production case: a
    // holder with 50+ unclaimed tokens got a flat 403 because this used to
    // send the whole `pending` list in a single request no matter its size.
    const groups: TokenMetadata[][] = [];
    for (let i = 0; i < pending.length; i += MAX_BATCH_CLAIM_SIZE) {
      groups.push(pending.slice(i, i + MAX_BATCH_CLAIM_SIZE));
    }

    let activePersona: {
      tokenId: string;
      address: string;
      signature: string;
      issuedAt: string;
      batchTokenIds: string[];
    } | null = null;
    let totalSucceeded = 0;
    const allFailed: Array<[string, { ok: boolean; reason?: string }]> = [];

    try {
      for (let g = 0; g < groups.length; g++) {
        setBulkProgress(
          groups.length > 1 ? { current: g + 1, total: groups.length } : null,
        );
        setBulkStage("signing");

        const tokenIds = groups[g].map((t) => t.tokenId);
        const issuedAt = new Date().toISOString();
        const message = buildBatchAuthMessage(tokenIds, address, issuedAt);
        const signature = await signMessage(address, message);

        // The signature is done at this point - what's left is a real
        // server round-trip (one live on-chain ownership check per token,
        // chunked+retried server-side, but still real RPC latency for a
        // big group). Without this stage change the button kept reading
        // "Sign in wallet..." straight through that wait, which read as
        // frozen and was enough to make someone reload mid-request,
        // aborting it before anything got marked claimed.
        setBulkStage("confirming");
        const res = await fetch("/api/claim/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokenIds, address, signature, issuedAt }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : `Unable to activate anons (${res.status}).`,
          );
        }

        const results = body.results as Record<
          string,
          { ok: boolean; reason?: string }
        >;
        const succeeded = Object.entries(results).filter(([, r]) => r.ok);
        const failed = Object.entries(results).filter(([, r]) => !r.ok);

        setClaimedTokens((current) => {
          const next = { ...current };
          for (const [tokenId] of succeeded) next[tokenId] = true;
          return next;
        });

        totalSucceeded += succeeded.length;
        allFailed.push(...failed);

        // Picks the first group's lowest succeeded tokenId as the active
        // posting identity - the persona carries THAT group's exact
        // signature/issuedAt/tokenIds (batchTokenIds), since a signature
        // only verifies against the exact list it was signed over (see
        // lib/auth-server.ts's verifyPersonaClaim). Only set once - later
        // groups don't override an already-active persona.
        if (!activePersona && succeeded.length > 0) {
          const activeTokenId = succeeded
            .map(([tokenId]) => tokenId)
            .sort((a, b) => Number(a) - Number(b))[0];
          activePersona = {
            tokenId: activeTokenId,
            address,
            signature,
            issuedAt,
            batchTokenIds: tokenIds,
          };
        }
      }

      if (activePersona) savePersona(activePersona);

      if (allFailed.length > 0) {
        setError(
          `Activated ${totalSucceeded} of ${pending.length} - ${allFailed
            .map(([tokenId, r]) => `#${tokenId} (${r.reason ?? "failed"})`)
            .join(", ")}.`,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to sign the batch claim.",
      );
    } finally {
      setBulkActivating(false);
      setBulkStage(null);
      setBulkProgress(null);
    }
  }, [address, tokens, claimedTokens, savePersona]);

  const handleChat = useCallback(() => {
    router.push("/board");
  }, [router]);

  // onAccountsChanged fires once immediately with whatever AppKit already
  // knows (restoring a session across reload/nav with no re-prompt, e.g.
  // after connecting via the header widget on a different page), then
  // again on every real change - see lib/wallet.ts. The setState calls
  // live inside this callback (not the effect body directly), which is
  // the pattern effects are meant for: "subscribe for updates from an
  // external system, calling setState in a callback."
  useEffect(() => {
    return onAccountsChanged((accounts) => {
      if (!accounts?.length) {
        setAddress(null);
        setTokens([]);
        setState("idle");
        return;
      }
      setAddress(accounts[0]);
      loadTokens(accounts[0]);
    });
  }, [loadTokens]);

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-5xl flex-col items-center px-6 py-10">
        <WhatIsHoodchan />
        <div className="flex w-full justify-end mb-2">
          <RentAdSpaceButton />
        </div>
        <AdBanner paidAds={paidAds} />
        {address && (
          // Collapsed by default (no `open` attribute) - the wallet/token
          // section used to fully replace the board below whenever a
          // wallet was connected (or even just while tokens were loading,
          // or when none were found), so anyone who just wanted to browse
          // lost the board entirely the moment they connected. Now it's a
          // dismissible box that never hides anything else on the page.
          <details className="hc-box w-full mb-4 px-4 py-3">
            <summary className="cursor-pointer hc-title text-base">
              Your wallet
              {state === "ready" && tokens.length > 0
                ? ` (${tokens.length} anon${tokens.length === 1 ? "" : "s"})`
                : ""}
            </summary>
            {state === "loading-tokens" && (
              <p className="text-center">
                Scanning Robinhood Chain for your HOODCHAN tokens...
              </p>
            )}

            {state === "ready" && tokens.length === 0 && (
              <div className="hc-box text-center py-16 px-6">
                <p className="hc-title text-lg mb-1">
                  No HOODCHAN tokens found in this wallet.
                </p>
                <p className="hc-thread-meta text-sm mb-5">
                  Hold at least one to post as your anon.
                </p>
                <a
                  href={OPENSEA_COLLECTION_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hc-button inline-block"
                >
                  Buy a HOODCHAN on OpenSea
                </a>
              </div>
            )}

            {state === "ready" && tokens.length > 0 && (
              <>
                {tokens.some((t) => !claimedTokens[t.tokenId]) && (
                  <div className="mb-4 flex flex-col items-center gap-1">
                    <button
                      onClick={handleActivateAll}
                      disabled={bulkActivating || claimingId !== null}
                      className="hc-button"
                    >
                      {bulkStage === "signing"
                        ? bulkProgress
                          ? `Sign in wallet (${bulkProgress.current} of ${bulkProgress.total})...`
                          : "Sign in wallet..."
                        : bulkStage === "confirming"
                          ? "Activating - do not close this tab..."
                          : "Activate All"}
                    </button>
                    <p className="hc-thread-meta text-xs">
                      {bulkStage === "confirming"
                        ? "Verifying ownership on-chain - this can take a few seconds for a lot of anons."
                        : bulkProgress
                          ? `You have more than ${MAX_BATCH_CLAIM_SIZE} unclaimed anons - this needs ${bulkProgress.total} signatures, one per group of ${MAX_BATCH_CLAIM_SIZE}.`
                          : "One signature activates every unclaimed anon below."}
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {tokens.map((token) => {
                    const isActivePersona =
                      persona?.tokenId === token.tokenId &&
                      persona?.address.toLowerCase() === address?.toLowerCase();
                    const isClaimed = claimedTokens[token.tokenId] === true;
                    const isClaiming = claimingId === token.tokenId;
                    const stagePct =
                      claimStage === "preparing"
                        ? 30
                        : claimStage === "signing"
                          ? 65
                          : claimStage === "confirming"
                            ? 90
                            : 0;
                    const wallet = wallets[token.tokenId];

                    return (
                      <div
                        key={token.tokenId}
                        className="hc-box overflow-hidden"
                      >
                        <TokenImage token={token} />
                        <div className="p-2 text-center">
                          <div className="hc-post-tokenid text-sm mb-2">
                            Anon #{token.tokenId}
                          </div>
                          {wallet && (
                            // "smart wallet ... deployed/not deployed", not
                            // "active"/"not yet activated" - this is the
                            // token-bound account's on-chain deployment
                            // status (see lib/tba.ts), a totally separate
                            // concept from whether you can post as this
                            // anon (that's the claimed/Activate button
                            // below). The old "not yet activated" wording
                            // read as if it were blocking the Activate
                            // button, which it never did - real user
                            // confusion traced back to this exact label.
                            <a
                              href={`/wallet/${token.tokenId}`}
                              className="hc-thread-meta mb-2 block font-mono text-[0.65rem] hover:underline"
                              title={wallet.address}
                            >
                              smart wallet: {truncateAddress(wallet.address)}{" "}
                              {wallet.activated ? (
                                <span style={{ color: "var(--hc-greentext)" }}>
                                  · deployed
                                </span>
                              ) : (
                                <span className="opacity-70">
                                  · not deployed (optional, doesn&apos;t affect
                                  posting)
                                </span>
                              )}
                            </a>
                          )}
                          {isActivePersona ? (
                            <button
                              onClick={handleChat}
                              className="hc-button w-full text-xs"
                            >
                              Chat as this anon
                            </button>
                          ) : isClaimed ? (
                            <div className="flex flex-col gap-1.5">
                              <span
                                className="text-xs font-bold"
                                style={{ color: "var(--hc-header-to)" }}
                              >
                                ✓ Activated
                              </span>
                              <button
                                onClick={() => handleClaim(token)}
                                disabled={isClaiming}
                                className="hc-button-ghost hc-button w-full text-xs"
                              >
                                {isClaiming
                                  ? "Sign in wallet..."
                                  : "Post as this anon instead"}
                              </button>
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => handleClaim(token)}
                                disabled={isClaiming}
                                className="hc-button-ghost hc-button w-full text-xs"
                              >
                                {isClaiming
                                  ? claimStage === "signing"
                                    ? "Sign in wallet..."
                                    : claimStage === "confirming"
                                      ? "Silencing clanker..."
                                      : "Preparing..."
                                  : "Activate this Anon"}
                              </button>
                              {isClaiming && (
                                <div
                                  className="hc-progress-track mt-2"
                                  style={{ height: "0.3rem" }}
                                >
                                  <div
                                    className="hc-progress-fill"
                                    style={{
                                      width: `${stagePct}%`,
                                      transition: "width 0.3s ease",
                                    }}
                                  />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </details>
        )}

        <div className="w-full">{popularThreads}</div>

        {error && (
          <p className="mt-6 text-sm text-center" style={{ color: "#a12b2b" }}>
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
