"use client";

import { useCallback, useEffect, useState } from "react";
import {
  connectWallet,
  hasInjectedWallet,
  onAccountsChanged,
} from "@/lib/wallet";
import {
  fetchWalletTokensOnChain,
  ipfsGatewayUrls,
  type TokenMetadata,
} from "@/lib/chain";

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
      <div className="w-full aspect-square bg-zinc-200 dark:bg-zinc-800" />
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
  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);

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
    <div className="flex flex-col flex-1 items-center bg-zinc-50 dark:bg-black font-mono">
      <main className="flex flex-1 w-full max-w-5xl flex-col items-center px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight mb-1">h00dchan</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-8 text-center">
          the anonymous imageboard for HOODCHAN holders
        </p>

        {!address ? (
          <button
            onClick={handleConnect}
            disabled={state === "connecting"}
            className="rounded border border-zinc-800 dark:border-zinc-200 px-6 py-3 font-semibold hover:bg-zinc-800 hover:text-white dark:hover:bg-zinc-200 dark:hover:text-black transition-colors disabled:opacity-50"
          >
            {state === "connecting" ? "Connecting..." : "Connect Wallet"}
          </button>
        ) : (
          <div className="w-full">
            <p className="text-xs text-zinc-500 mb-6 break-all text-center">
              connected: {address}
            </p>

            {state === "loading-tokens" && (
              <p className="text-center">
                Scanning Robinhood Chain for your HOODCHAN tokens...
              </p>
            )}

            {state === "ready" && tokens.length === 0 && (
              <div className="text-center py-16 border border-dashed border-zinc-300 dark:border-zinc-700 rounded">
                <p className="text-lg mb-1">
                  No HOODCHAN tokens found in this wallet.
                </p>
                <p className="text-sm text-zinc-500">
                  Hold at least one to post as your anon.
                </p>
              </div>
            )}

            {state === "ready" && tokens.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {tokens.map((token) => (
                  <div
                    key={token.tokenId}
                    className="border border-zinc-300 dark:border-zinc-700 rounded overflow-hidden bg-white dark:bg-zinc-900"
                  >
                    <TokenImage token={token} />
                    <div className="p-2 text-center text-sm font-semibold">
                      Anon #{token.tokenId}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="mt-6 text-sm text-red-600 dark:text-red-400 max-w-md text-center">
            {error}
          </p>
        )}

        {!hasInjectedWallet() && (
          <p className="mt-8 text-xs text-zinc-400 max-w-sm text-center">
            No wallet extension detected in this browser. Install MetaMask,
            Rabby, or another EIP-1193 wallet to connect.
          </p>
        )}
      </main>
    </div>
  );
}
