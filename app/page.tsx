"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  connectWallet,
  hasInjectedWallet,
  onAccountsChanged,
  signMessage,
} from "@/lib/wallet";
import {
  fetchWalletTokensOnChain,
  ipfsGatewayUrls,
  type TokenMetadata,
} from "@/lib/chain";
import {
  buildAuthMessage,
  PERSONA_SESSION_KEY,
  type PersonaClaim,
} from "@/lib/persona";

type LoadState = "idle" | "connecting" | "loading-tokens" | "ready" | "error";

// useSyncExternalStore, not a raw useEffect+setState, because
// window.ethereum is genuinely external, mutable browser state: it can be
// injected before or after React hydrates, and the server has no `window`
// at all. This is exactly the primitive React ships for "read a
// browser-only value the same way on server and client" - getServerSnapshot
// always returns false (matching what SSR renders), getSnapshot reads the
// real value once mounted. There's no injection-completed event to
// subscribe to, so subscribe() is a no-op.
function subscribeNoop() {
  return () => {};
}

function useWalletDetected() {
  return useSyncExternalStore(subscribeNoop, hasInjectedWallet, () => false);
}

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

export default function Home() {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const walletDetected = useWalletDetected();

  const loadTokens = useCallback(async (owner: string) => {
    setState("loading-tokens");
    setError(null);
    try {
      const tokenIds = await fetchWalletTokensOnChain(owner);
      const metadata = await Promise.all(
        tokenIds.map((id) => fetchTokenMetadataViaApi(id)),
      );
      const resolved = metadata
        .filter((m): m is TokenMetadata => m !== null)
        .sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
      setTokens(resolved);
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

  // Signs the "posting authorization" message for one token, stashes the
  // resulting claim in sessionStorage (not localStorage - a "posting as"
  // identity should not silently persist across browser restarts), then
  // sends the user to the board. The server independently re-verifies all
  // of this on every write (see lib/auth-server.ts) - nothing client-side
  // is trusted on its own.
  const handleClaim = useCallback(
    async (token: TokenMetadata) => {
      if (!address) return;
      setClaimingId(token.tokenId);
      setError(null);
      try {
        const issuedAt = new Date().toISOString();
        const message = buildAuthMessage(token.tokenId, address, issuedAt);
        const signature = await signMessage(address, message);
        const persona: PersonaClaim = {
          tokenId: token.tokenId,
          address,
          signature,
          issuedAt,
        };
        window.sessionStorage.setItem(
          PERSONA_SESSION_KEY,
          JSON.stringify(persona),
        );
        router.push("/board");
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to sign the claim message.",
        );
      } finally {
        setClaimingId(null);
      }
    },
    [address, router],
  );

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
        {!address ? (
          <button
            onClick={handleConnect}
            disabled={state === "connecting"}
            className="hc-button"
          >
            {state === "connecting" ? "Connecting..." : "Connect Wallet"}
          </button>
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
              <div className="hc-box text-center py-16">
                <p className="hc-title text-lg mb-1">
                  No HOODCHAN tokens found in this wallet.
                </p>
                <p className="hc-thread-meta text-sm">
                  Hold at least one to post as your anon.
                </p>
              </div>
            )}

            {state === "ready" && tokens.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {tokens.map((token) => (
                  <div key={token.tokenId} className="hc-box overflow-hidden">
                    <TokenImage token={token} />
                    <div className="p-2 text-center">
                      <div className="hc-post-tokenid text-sm mb-2">
                        Anon #{token.tokenId}
                      </div>
                      <button
                        onClick={() => handleClaim(token)}
                        disabled={claimingId === token.tokenId}
                        className="hc-button-ghost hc-button w-full text-xs"
                      >
                        {claimingId === token.tokenId
                          ? "Sign in wallet..."
                          : "Post as this Anon"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="mt-6 text-sm text-center" style={{ color: "#a12b2b" }}>
            {error}
          </p>
        )}

        {!walletDetected && (
          <p className="hc-thread-meta mt-8 max-w-sm text-center">
            No wallet extension detected in this browser. Install MetaMask,
            Rabby, or another EIP-1193 wallet to connect.
          </p>
        )}
      </main>
    </div>
  );
}
