import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrFetchTokenMetadata } from "@/lib/store";
import { isValidTokenId } from "@/lib/persona";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import { fetchWalletHoldings, type WalletHoldings } from "@/lib/alchemy";
import { PostImage } from "@/app/components/PostImage";
import { BLOCK_EXPLORER_URL } from "@/lib/chain";
import { WalletHoldingsView } from "@/app/components/WalletHoldingsView";

export const dynamic = "force-dynamic";

const WEI_PER_ETH = BigInt("1000000000000000000");

function formatEth(weiHex: string): string {
  const wei = BigInt(weiHex);
  const whole = wei / WEI_PER_ETH;
  const frac = wei % WEI_PER_ETH;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
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
            <a
              href={`${BLOCK_EXPLORER_URL}/address/${tbaAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hc-link break-all font-mono text-xs block"
            >
              {tbaAddress}
            </a>
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

            <WalletHoldingsView
              nfts={holdings.nfts}
              tokenBalances={holdings.tokenBalances}
            />
          </>
        )}
      </main>
    </div>
  );
}
