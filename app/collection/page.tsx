"use client";

// Dedicated collection page - the claim/activate token grid used to live
// embedded in the homepage body (gated behind `{address && ...}`), which
// meant a connected wallet's screen was dominated by this grid instead of
// board content. Reported live: the home page should stay freely
// browsable like a real imageboard, with wallet management reachable from
// the header (WalletHeaderWidget's "Browse all your anons ->") instead of
// taking over the middle of the screen. This page is that destination -
// same claim/activate logic as before, just moved off "/" entirely.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { WalletIcon, ChatIcon } from "@/app/components/Icons";
import { onAccountsChanged, signMessage, connectWallet } from "@/lib/wallet";
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

// token.image (resolved once and cached server-side, see lib/store.ts's
// getOrFetchTokenMetadata) tries FIRST - same fix as app/components/
// PostImage.tsx, same root cause: starting from a live IPFS gateway race
// on every load instead of the already-resolved (often Blob-backed, fast)
// URL was the actual cause of images loading in slowly one at a time on
// pages with many of these at once.
function TokenImage({ token }: { token: TokenMetadata }) {
  const rawImageUri =
    typeof token.raw.image === "string" ? token.raw.image : "";
  const sources = useMemo(() => {
    const gatewayCandidates = rawImageUri ? ipfsGatewayUrls(rawImageUri) : [];
    return [token.image, ...gatewayCandidates].filter(Boolean);
  }, [token.image, rawImageUri]);
  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];

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
          current + 1 < sources.length ? current + 1 : current,
        );
      }}
    />
  );
}

export default function CollectionPage() {
  const router = useRouter();
  const { persona, savePersona } = useActivePersona();
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [wallets, setWallets] = useState<Record<string, TbaInfo>>({});
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [claimedTokens, setClaimedTokens] = useState<Record<string, boolean>>(
    {},
  );
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimStage, setClaimStage] = useState<ClaimStage>(null);
  const [bulkActivating, setBulkActivating] = useState(false);
  const [bulkStage, setBulkStage] = useState<"signing" | "confirming" | null>(
    null,
  );
  const [bulkProgress, setBulkProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const loadTokens = useCallback(async (owner: string) => {
    setError(null);
    const renderCache = readWalletRenderCache(owner);
    if (renderCache) {
      setTokens(renderCache.tokens as TokenMetadata[]);
      setWallets(renderCache.wallets as Record<string, TbaInfo>);
      setClaimedTokens(renderCache.claimedTokens);
      setLevels(renderCache.levels ?? {});
      setState("ready");
    } else {
      setState("loading-tokens");
      setWallets({});
      setClaimedTokens({});
      setLevels({});
    }

    async function attempt(isRetry: boolean): Promise<void> {
      try {
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
        const walletMap: Record<string, TbaInfo> = {
          ...((renderCache?.wallets as Record<string, TbaInfo>) ?? {}),
          ...(walletBody.wallets ?? {}),
        };
        const levelMap: Record<string, number> = {
          ...(renderCache?.levels ?? {}),
          ...(walletBody.levels ?? {}),
        };

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
        setLevels(levelMap);
        setState("ready");
        writeWalletRenderCache(owner, {
          tokens: resolved,
          wallets: walletMap,
          claimedTokens: claimedMap,
          levels: levelMap,
        });
      } catch (err) {
        if (renderCache) {
          console.error("Background wallet refresh failed", err);
          if (!isRetry) {
            setTimeout(() => attempt(true), 3000);
          }
          return;
        }
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load HOODCHAN tokens.",
        );
        setState("error");
      }
    }

    await attempt(false);
  }, []);

  const handleClaim = useCallback(
    async (
      token: TokenMetadata,
      options?: { forceActive?: boolean },
    ): Promise<boolean> => {
      if (!address) return false;
      setClaimingId(token.tokenId);
      setClaimStage("preparing");
      setError(null);
      try {
        const issuedAt = new Date().toISOString();
        const message = buildAuthMessage(token.tokenId, address, issuedAt);
        setClaimStage("signing");
        const signature = await signMessage(address, message);
        const claim = {
          tokenId: token.tokenId,
          address,
          signature,
          issuedAt,
        };

        setClaimStage("confirming");
        const res = await fetch("/api/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(claim),
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
        if (options?.forceActive || !persona) {
          savePersona(claim);
        }
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
    [address, persona, savePersona],
  );

  const handleActivateAll = useCallback(async () => {
    const pending = tokens.filter((t) => !claimedTokens[t.tokenId]);
    if (!address || pending.length === 0) return;
    setBulkActivating(true);
    setError(null);

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

      if (activePersona && !persona) savePersona(activePersona);

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
  }, [address, tokens, claimedTokens, persona, savePersona]);

  const handleChat = useCallback(() => {
    router.push("/board");
  }, [router]);

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

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await connectWallet();
    } catch {
      // AppKit's own modal surfaces why; nothing else to do here.
    } finally {
      setConnecting(false);
    }
  };

  if (!address) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 gap-4 text-center">
        <h1 className="hc-title text-2xl">Your collection</h1>
        <p className="hc-thread-meta text-sm max-w-sm">
          Connect a wallet to see, claim, and activate your HOODCHAN anons.
        </p>
        <div className="hc-box flex flex-col gap-3 p-4 w-full max-w-sm">
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="hc-button"
          >
            {connecting ? "Connecting..." : "Connect Wallet"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-5xl flex-col items-center px-6 py-10">
        <div className="flex w-full items-center justify-between mb-4">
          <h1 className="hc-title text-xl">
            Your collection
            {state === "ready" && tokens.length > 0
              ? ` (${tokens.length} anon${tokens.length === 1 ? "" : "s"})`
              : ""}
          </h1>
          <Link href="/board" className="hc-button-ghost hc-button text-xs">
            Go to board
          </Link>
        </div>

        {state === "loading-tokens" && (
          <p className="text-center">
            Scanning Robinhood Chain for your HOODCHAN tokens...
          </p>
        )}

        {state === "ready" && tokens.length === 0 && (
          <div className="hc-box text-center py-16 px-6 w-full">
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
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 w-full">
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
                const level = levels[token.tokenId];

                return (
                  <div key={token.tokenId} className="hc-box overflow-hidden">
                    <Link
                      href={`/wallet/${token.tokenId}`}
                      className={`hc-profile-card block w-full ${level !== undefined ? "hc-profile-card-has-level" : ""}`}
                    >
                      <TokenImage token={token} />
                      {level !== undefined && (
                        <span className="hc-profile-card-level-badge">
                          <span className="hc-profile-card-level-label">
                            LV
                          </span>
                          <span className="hc-profile-card-level-num">
                            {level}
                          </span>
                        </span>
                      )}
                      <div className="hc-profile-card-plate">
                        <span className="hc-profile-card-name">
                          Anon #{token.tokenId}
                        </span>
                      </div>
                    </Link>
                    <div className="p-2 text-center">
                      {wallet && (
                        <div className="mb-2">
                          <Link
                            href={`/wallet/${token.tokenId}`}
                            className={
                              wallet.activated
                                ? "hc-button-ghost hc-button w-full text-xs"
                                : "hc-wallet-status-btn hc-wallet-status-inactive"
                            }
                            title={wallet.address}
                          >
                            <WalletIcon className="hc-btn-icon" />
                            {wallet.activated
                              ? "Go to profile"
                              : "Activate wallet"}
                          </Link>
                        </div>
                      )}
                      {isActivePersona ? (
                        <button
                          onClick={handleChat}
                          className="hc-button w-full text-xs"
                        >
                          <ChatIcon className="hc-btn-icon" />
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
                            onClick={() =>
                              handleClaim(token, { forceActive: true })
                            }
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
                              : "Claim & silence AI"}
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

        {error && (
          <p className="mt-6 text-sm text-center" style={{ color: "#a12b2b" }}>
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
