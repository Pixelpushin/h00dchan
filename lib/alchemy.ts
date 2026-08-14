// Alchemy enhanced APIs for the wallet explorer - NFT holdings, ERC-20
// balances, and native ETH balance for a given address on Robinhood Chain.
// Re-verified live against a real HOODCHAN holder address just before
// writing this (not assumed from the plan doc, which had guessed the wrong
// NFT method): `getNFTsForOwner` is the NFT API v3 REST endpoint
// (`/nft/v3/<key>/getNFTsForOwner?owner=...`), NOT the older
// `alchemy_getNFTs` JSON-RPC method - that's a real, distinct base path
// from the `/v2/<key>` JSON-RPC endpoint the balance calls use. Both
// confirmed returning real data. Server only - ALCHEMY_API_KEY is not
// NEXT_PUBLIC_, this must never be imported from a client component.
const ALCHEMY_RPC_BASE = "https://robinhood-mainnet.g.alchemy.com/v2";
const ALCHEMY_NFT_BASE = "https://robinhood-mainnet.g.alchemy.com/nft/v3";

function apiKey(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY is not configured.");
  return key;
}

async function alchemyRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`${ALCHEMY_RPC_BASE}/${apiKey()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

async function fetchNftsForOwner(
  owner: string,
): Promise<{ ownedNfts?: AlchemyNftItem[] }> {
  const url = `${ALCHEMY_NFT_BASE}/${apiKey()}/getNFTsForOwner?owner=${owner}&withMetadata=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`getNFTsForOwner responded ${res.status}`);
  return res.json();
}

export interface WalletNft {
  contractAddress: string;
  tokenId: string;
  name: string | null;
  imageUrl: string | null;
}

export interface WalletTokenBalance {
  contractAddress: string;
  balance: string; // raw hex balance, uint256
}

export interface WalletHoldings {
  address: string;
  ethBalanceWei: string;
  nfts: WalletNft[];
  tokenBalances: WalletTokenBalance[];
}

interface AlchemyNftItem {
  contract?: { address?: string };
  tokenId?: string;
  name?: string;
  image?: { cachedUrl?: string; originalUrl?: string };
}

interface AlchemyTokenBalanceItem {
  contractAddress?: string;
  tokenBalance?: string;
}

// Three calls fired concurrently, not sequentially - each is independent
// and there's no reason to make a user wait for the sum of all three
// instead of the slowest one.
export async function fetchWalletHoldings(
  address: string,
): Promise<WalletHoldings> {
  const [ethBalanceWei, nftResult, tokenResult] = await Promise.all([
    alchemyRpc<string>("eth_getBalance", [address, "latest"]),
    fetchNftsForOwner(address).catch(() => ({ ownedNfts: [] })),
    alchemyRpc<{ tokenBalances?: AlchemyTokenBalanceItem[] }>(
      "alchemy_getTokenBalances",
      [address],
    ).catch(() => ({ tokenBalances: [] })),
  ]);

  const nfts: WalletNft[] = (nftResult.ownedNfts ?? []).map((item) => ({
    contractAddress: item.contract?.address ?? "",
    tokenId: item.tokenId ?? "",
    name: item.name ?? null,
    imageUrl: item.image?.cachedUrl ?? item.image?.originalUrl ?? null,
  }));

  const tokenBalances: WalletTokenBalance[] = (tokenResult.tokenBalances ?? [])
    .filter(
      (item) =>
        item.contractAddress &&
        item.tokenBalance &&
        BigInt(item.tokenBalance) > BigInt(0),
    )
    .map((item) => ({
      contractAddress: item.contractAddress!,
      balance: item.tokenBalance!,
    }));

  return { address, ethBalanceWei, nfts, tokenBalances };
}
