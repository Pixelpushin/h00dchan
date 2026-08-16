import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrFetchTokenMetadata } from "@/lib/store";
import { isValidTokenId } from "@/lib/persona";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import { fetchWalletHoldings, type WalletHoldings } from "@/lib/alchemy";
import { PostImage } from "@/app/components/PostImage";

export const dynamic = "force-dynamic";

const WEI_PER_ETH = BigInt("1000000000000000000");

function formatEth(weiHex: string): string {
  const wei = BigInt(weiHex);
  const whole = wei / WEI_PER_ETH;
  const frac = wei % WEI_PER_ETH;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${fracStr}`;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Mirrors formatEth's whole/fractional split, but for an arbitrary ERC-20's
// decimals instead of the hardcoded 18 for ETH.
function formatTokenAmount(rawBalance: string, decimals: number): string {
  const amount = BigInt(rawBalance);
  if (decimals <= 0) return amount.toString();
  const unit = BigInt(10) ** BigInt(decimals);
  const whole = amount / unit;
  const frac = amount % unit;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${fracStr}`;
}

export default async function WalletPage({
  params,
}: {
  params: Promise<{ tokenId: string }>;
}) {
  const { tokenId } = await params;
  if (!isValidTokenId(tokenId)) notFound();

  const metadata = await getOrFetchTokenMetadata(tokenId).catch(() => null);
  const tbaAddress = await computeTbaAddress(tokenId);
  const activated = await isTbaActivated(tbaAddress);

  let holdings: WalletHoldings | null = null;
  let holdingsError: string | null = null;
  try {
    holdings = await fetchWalletHoldings(tbaAddress);
  } catch {
    holdingsError = "Unable to load holdings for this wallet right now.";
  }

  const rawImageUri =
    metadata && typeof metadata.raw.image === "string"
      ? metadata.raw.image
      : "";

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <Link href="/" className="hc-link text-sm">
          ‹ back to h00dchan
        </Link>

        <div className="hc-box flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          {metadata && (
            <PostImage
              rawImageUri={rawImageUri}
              fallbackSrc={metadata.image}
              alt={metadata.name}
              className="hc-post-image w-20 h-20 shrink-0 object-cover"
            />
          )}
          <div>
            <h1 className="hc-title text-xl">Anon #{tokenId}&apos;s wallet</h1>
            <p className="hc-thread-meta break-all font-mono text-xs">
              {tbaAddress}
            </p>
            <p className="hc-thread-meta text-xs mt-1">
              {activated ? (
                <span style={{ color: "var(--hc-greentext)" }}>
                  ● active token-bound account
                </span>
              ) : (
                <span className="opacity-70">
                  ● not yet activated - a counterfactual address, can still
                  receive assets
                </span>
              )}
            </p>
          </div>
        </div>

        {holdingsError && (
          <p className="text-sm text-center" style={{ color: "#a12b2b" }}>
            {holdingsError}
          </p>
        )}

        {holdings && (
          <>
            <div className="hc-box p-4">
              <div className="hc-thread-meta text-xs mb-1">ETH balance</div>
              <div className="hc-title text-lg">
                {formatEth(holdings.ethBalanceWei)} ETH
              </div>
            </div>

            <div className="hc-box p-4">
              <div className="hc-thread-meta text-xs mb-2">
                NFTs ({holdings.nfts.length})
              </div>
              {holdings.nfts.length === 0 ? (
                <p className="hc-thread-meta text-sm">
                  Nothing in this wallet yet.
                </p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {holdings.nfts.map((nft) => (
                    <div
                      key={`${nft.contractAddress}-${nft.tokenId}`}
                      className="hc-box overflow-hidden"
                    >
                      {nft.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={nft.imageUrl}
                          alt={nft.name ?? nft.tokenId}
                          className="w-full aspect-square object-cover"
                        />
                      ) : (
                        <div
                          className="w-full aspect-square"
                          style={{ background: "var(--hc-box-alt)" }}
                        />
                      )}
                      <div className="p-1.5 text-center hc-thread-meta text-[0.65rem] truncate">
                        {nft.name ?? `#${nft.tokenId}`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="hc-box p-4">
              <div className="hc-thread-meta text-xs mb-2">
                Tokens ({holdings.tokenBalances.length})
              </div>
              {holdings.tokenBalances.length === 0 ? (
                <p className="hc-thread-meta text-sm">
                  No ERC-20 balances in this wallet yet.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {holdings.tokenBalances.map((token) => {
                    const label =
                      token.symbol ??
                      token.name ??
                      truncateAddress(token.contractAddress);
                    const amount =
                      token.decimals !== null
                        ? formatTokenAmount(token.balance, token.decimals)
                        : `${BigInt(token.balance).toString()} (raw units)`;
                    return (
                      <div
                        key={token.contractAddress}
                        className="flex items-center justify-between font-mono text-xs"
                      >
                        <span>{label}</span>
                        <span className="hc-thread-meta">{amount}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
