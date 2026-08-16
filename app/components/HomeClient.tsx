"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { onAccountsChanged, signMessage } from "@/lib/wallet";
import { WhatIsHoodchan } from "@/app/components/WhatIsHoodchan";
import { AdBanner, type PaidAd } from "@/app/components/AdBanner";
import { RentAdSpaceButton } from "@/app/components/RentAdSpaceButton";
import { useActivePersona } from "@/lib/usePersona";

const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/h00dchan";
import {
  fetchWalletTokensOnChain,
  ipfsGatewayUrls,
  readBlockNumber,
  type TokenMetadata,
} from "@/lib/chain";
import { buildAuthMessage, buildBatchAuthMessage } from "@/lib/persona";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import {
  nextBlockHex,
  readWalletCache,
  writeWalletCache,
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

// Same raw-RPC-stays-client-side reasoning as fetchWalletTokensOnChain
// above: the registry lives behind the same Robinhood Chain RPC already
// verified CORS-open, so there's no need for a server route here - see
// lib/tba.ts for what's actually being computed and why no deployment is
// required for this read-only part.
async function fetchTbaInfo(tokenId: string): Promise<TbaInfo | null> {
  try {
    const address = await computeTbaAddress(tokenId);
    const activated = await isTbaActivated(address);
    return { address, activated };
  } catch {
    return null;
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

  // Full history scan (fetchWalletTokensOnChain's eth_getLogs over the
  // whole contract, from block 0) only ever needs to happen once per
  // browser per address - after that, the cached token list + last scanned
  // block let every later load (including a plain refresh, which used to
  // re-run the full scan every single time) ask the chain for only what's
  // changed since. Ownership is still re-verified live either way (see
  // fetchWalletTokensOnChain), so a token sold away since the last visit is
  // correctly dropped, not just accumulated.
  const loadTokens = useCallback(async (owner: string) => {
    setState("loading-tokens");
    setError(null);
    setWallets({});
    setClaimedTokens({});
    try {
      const cached = readWalletCache(owner);
      const [tokenIds, currentBlock] = await Promise.all([
        fetchWalletTokensOnChain(owner, {
          fromBlock: cached ? nextBlockHex(cached.lastScannedBlock) : "0x0",
          knownTokenIds: cached?.tokenIds,
        }),
        readBlockNumber(),
      ]);
      writeWalletCache(owner, { tokenIds, lastScannedBlock: currentBlock });
      const [metadata, walletInfos, claimedFlags] = await Promise.all([
        Promise.all(tokenIds.map((id) => fetchTokenMetadataViaApi(id))),
        Promise.all(tokenIds.map((id) => fetchTbaInfo(id))),
        Promise.all(tokenIds.map((id) => fetchClaimedStatus(id))),
      ]);
      const resolved = metadata
        .filter((m): m is TokenMetadata => m !== null)
        .sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
      setTokens(resolved);
      const walletMap: Record<string, TbaInfo> = {};
      const claimedMap: Record<string, boolean> = {};
      tokenIds.forEach((id, i) => {
        const info = walletInfos[i];
        if (info) walletMap[id] = info;
        if (claimedFlags[i]) claimedMap[id] = true;
      });
      setWallets(walletMap);
      setClaimedTokens(claimedMap);
      setState("ready");
    } catch (err) {
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
    setBulkStage("signing");
    setError(null);
    try {
      const tokenIds = pending.map((t) => t.tokenId);
      const issuedAt = new Date().toISOString();
      const message = buildBatchAuthMessage(tokenIds, address, issuedAt);
      const signature = await signMessage(address, message);

      // The signature is done at this point - what's left is a real
      // server round-trip (one live on-chain ownership check per token,
      // now parallelized, but still real RPC latency for a big batch).
      // Without this stage change the button kept reading "Sign in
      // wallet..." straight through that wait, which read as frozen and
      // was enough to make someone reload mid-request, aborting it before
      // anything got marked claimed.
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

      if (failed.length > 0) {
        setError(
          `Activated ${succeeded.length} of ${pending.length} - ${failed
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
    }
  }, [address, tokens, claimedTokens]);

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
        {!address ? (
          <div className="w-full">{popularThreads}</div>
        ) : (
          <div className="w-full">
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
                        ? "Sign in wallet..."
                        : bulkStage === "confirming"
                          ? "Activating - do not close this tab..."
                          : "Activate All"}
                    </button>
                    <p className="hc-thread-meta text-xs">
                      {bulkStage === "confirming"
                        ? "Verifying ownership on-chain - this can take a few seconds for a lot of anons."
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
                            <a
                              href={`/wallet/${token.tokenId}`}
                              className="hc-thread-meta mb-2 block font-mono text-[0.65rem] hover:underline"
                              title={wallet.address}
                            >
                              wallet: {truncateAddress(wallet.address)}{" "}
                              {wallet.activated ? (
                                <span style={{ color: "var(--hc-greentext)" }}>
                                  · active
                                </span>
                              ) : (
                                <span className="opacity-70">
                                  · not yet activated
                                </span>
                              )}
                            </a>
                          )}
                          {isActivePersona ? (
                            <button
                              onClick={handleChat}
                              className="hc-button w-full text-xs"
                            >
                              Chat with this anon
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
          </div>
        )}

        {error && (
          <p className="mt-6 text-sm text-center" style={{ color: "#a12b2b" }}>
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
