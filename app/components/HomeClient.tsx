"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { connectWallet, onAccountsChanged, signMessage } from "@/lib/wallet";
import { WhatIsHoodchan } from "@/app/components/WhatIsHoodchan";
import { AdBanner } from "@/app/components/AdBanner";
import { useActivePersona } from "@/lib/usePersona";

const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/h00dchan";
import {
  fetchWalletTokensOnChain,
  ipfsGatewayUrls,
  readBlockNumber,
  type TokenMetadata,
} from "@/lib/chain";
import { buildAuthMessage } from "@/lib/persona";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import {
  nextBlockHex,
  readWalletCache,
  writeWalletCache,
} from "@/lib/walletCache";

type ClaimStage = "preparing" | "signing" | null;

interface TbaInfo {
  address: string;
  activated: boolean;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

type LoadState = "idle" | "connecting" | "loading-tokens" | "ready" | "error";

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
}: {
  popularThreads: ReactNode;
}) {
  const router = useRouter();
  const { persona, savePersona } = useActivePersona();
  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [wallets, setWallets] = useState<Record<string, TbaInfo>>({});
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimStage, setClaimStage] = useState<ClaimStage>(null);

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
      const [metadata, walletInfos] = await Promise.all([
        Promise.all(tokenIds.map((id) => fetchTokenMetadataViaApi(id))),
        Promise.all(tokenIds.map((id) => fetchTbaInfo(id))),
      ]);
      const resolved = metadata
        .filter((m): m is TokenMetadata => m !== null)
        .sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
      setTokens(resolved);
      const walletMap: Record<string, TbaInfo> = {};
      tokenIds.forEach((id, i) => {
        const info = walletInfos[i];
        if (info) walletMap[id] = info;
      });
      setWallets(walletMap);
      setState("ready");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load HOODCHAN tokens.",
      );
      setState("error");
    }
  }, []);

  const handleConnect = useCallback(async () => {
    setState("connecting");
    setError(null);
    try {
      const account = await connectWallet();
      setAddress(account);
      await loadTokens(account);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to connect wallet.",
      );
      setState("error");
    }
  }, [loadTokens]);

  // Signs the "posting authorization" message for one token and stashes the
  // resulting claim via useActivePersona (sessionStorage-backed - not
  // localStorage, a "posting as" identity should not silently persist
  // across browser restarts, but it DOES survive a same-tab reload, which
  // is the point: once activated, the card below flips to a persistent
  // "Chat with this anon" button instead of asking to sign again. No
  // auto-navigation here - activating and chatting are separate, explicit
  // steps now. The server independently re-verifies all of this on every
  // write (see lib/auth-server.ts) - nothing client-side is trusted on its
  // own.
  const handleClaim = useCallback(
    async (token: TokenMetadata) => {
      if (!address) return;
      setClaimingId(token.tokenId);
      setClaimStage("preparing");
      setError(null);
      try {
        const issuedAt = new Date().toISOString();
        const message = buildAuthMessage(token.tokenId, address, issuedAt);
        setClaimStage("signing");
        const signature = await signMessage(address, message);
        savePersona({ tokenId: token.tokenId, address, signature, issuedAt });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to sign the claim message.",
        );
      } finally {
        setClaimingId(null);
        setClaimStage(null);
      }
    },
    [address, savePersona],
  );

  const handleChat = useCallback(() => {
    router.push("/board");
  }, [router]);

  // onAccountsChanged fires once immediately with whatever AppKit already
  // knows (restoring a session across reload/nav with no re-prompt), then
  // again on every real change - see lib/wallet.ts.
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
        <AdBanner />
        {!address ? (
          <div className="w-full flex flex-col items-center">
            <button
              onClick={handleConnect}
              disabled={state === "connecting"}
              className="hc-button mb-8"
            >
              {state === "connecting" ? "Connecting..." : "Connect Wallet"}
            </button>
            <div className="w-full">{popularThreads}</div>
          </div>
        ) : (
          <div className="w-full">
            <p className="hc-thread-meta mb-6 break-all text-center">
              connected: {address}
            </p>

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
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {tokens.map((token) => {
                  const isActive =
                    persona?.tokenId === token.tokenId &&
                    persona?.address.toLowerCase() === address?.toLowerCase();
                  const isClaiming = claimingId === token.tokenId;
                  const stagePct =
                    claimStage === "preparing"
                      ? 40
                      : claimStage === "signing"
                        ? 85
                        : 0;
                  const wallet = wallets[token.tokenId];

                  return (
                    <div key={token.tokenId} className="hc-box overflow-hidden">
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
                        {isActive ? (
                          <button
                            onClick={handleChat}
                            className="hc-button w-full text-xs"
                          >
                            Chat with this anon
                          </button>
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
