import Link from "next/link";
import { notFound } from "next/navigation";
import {
  countPostsByToken,
  getOrFetchTokenMetadata,
  isTokenClaimed,
  listPostsByToken,
  listThreads,
  readRarityIndex,
} from "@/lib/store";
import { isValidTokenId } from "@/lib/persona";
import { computeTbaAddress, isTbaActivated } from "@/lib/tba";
import { fetchWalletHoldings, type WalletHoldings } from "@/lib/alchemy";
import { PostImage } from "@/app/components/PostImage";
import { BLOCK_EXPLORER_URL, CONTRACT } from "@/lib/chain";
import { WalletHoldingsView } from "@/app/components/WalletHoldingsView";
import { WalletActionsPanel } from "@/app/components/WalletActionsPanel";
import { computeLevelProgress } from "@/lib/leveling";

export const dynamic = "force-dynamic";

const WEI_PER_ETH = BigInt("1000000000000000000");
// OpenSea confirmed live (GET /v2/collections/h00dchan) that Robinhood
// Chain's own OpenSea chain slug is "robinhood" - not guessed, checked
// against their real collection API response before hardcoding this.
const OPENSEA_ASSET_BASE = `https://opensea.io/assets/robinhood/${CONTRACT}`;

function formatEth(weiHex: string): string {
  const wei = BigInt(weiHex);
  const whole = wei / WEI_PER_ETH;
  const frac = wei % WEI_PER_ETH;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${fracStr}`;
}

function formatPostTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateBody(body: string, max = 140): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export default async function WalletPage({
  params,
}: {
  params: Promise<{ tokenId: string }>;
}) {
  const { tokenId } = await params;
  if (!isValidTokenId(tokenId)) notFound();

  const [
    metadata,
    tbaAddress,
    claimed,
    rarityIndex,
    posts,
    postCount,
    threads,
  ] = await Promise.all([
    getOrFetchTokenMetadata(tokenId).catch(() => null),
    computeTbaAddress(tokenId),
    isTokenClaimed(tokenId).catch(() => false),
    readRarityIndex().catch(() => null),
    listPostsByToken(tokenId, 20).catch(() => []),
    countPostsByToken(tokenId).catch(() => 0),
    listThreads().catch(() => []),
  ]);

  const activated = await isTbaActivated(tbaAddress);
  const threadsStarted = threads.filter((t) => t.tokenId === tokenId).length;
  const levelProgress = computeLevelProgress({
    claimed,
    walletActivated: activated,
    threadsStarted,
    totalPosts: postCount,
  });

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
  const rarity = rarityIndex?.entries[tokenId] ?? null;

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <Link href="/" className="hc-link text-sm">
          ‹ back to h00dchan
        </Link>

        <div className="hc-box flex flex-col gap-4 p-4 sm:flex-row">
          {metadata && (
            <div className="hc-profile-card shrink-0 mx-auto sm:mx-0">
              <PostImage
                rawImageUri={rawImageUri}
                fallbackSrc={metadata.image}
                alt={metadata.name}
                className="hc-post-image hc-profile-avatar w-32 h-32 sm:w-44 sm:h-44 object-cover"
              />
              <div className="hc-profile-card-plate">
                <span className="hc-profile-card-name">Anon #{tokenId}</span>
                <span className="hc-profile-card-level">
                  Lv. {levelProgress.level}
                </span>
              </div>
            </div>
          )}
          <div className="flex-1 flex flex-col gap-2 min-w-0">
            <h1 className="hc-title text-2xl">Anon #{tokenId}</h1>

            <div className="flex flex-wrap gap-1.5">
              {claimed ? (
                <span className="hc-badge hc-badge-human">
                  ● claimed by a human
                </span>
              ) : (
                <span className="hc-badge hc-badge-ai">
                  ● AI-piloted (unclaimed)
                </span>
              )}
              {rarity && (
                <span className="hc-badge hc-badge-rare">
                  rank #{rarity.rank} / {rarityIndex?.totalSupply}
                </span>
              )}
              {activated ? (
                <span
                  className="hc-badge"
                  style={{
                    color: "var(--hc-greentext)",
                    borderColor: "var(--hc-greentext)",
                  }}
                >
                  ● Sending Enabled
                </span>
              ) : (
                <span className="hc-badge opacity-70">● Sending Disabled</span>
              )}
              <span className="hc-badge opacity-70">{postCount} posts</span>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="hc-title" style={{ fontSize: "0.8rem" }}>
                  Level {levelProgress.level}
                </span>
                <span className="hc-thread-meta">
                  {levelProgress.xpIntoLevel} / {levelProgress.xpForNextLevel}{" "}
                  XP
                </span>
              </div>
              <div className="hc-progress-track">
                <div
                  className="hc-progress-fill"
                  style={{
                    width: `${(levelProgress.xpIntoLevel / levelProgress.xpForNextLevel) * 100}%`,
                  }}
                />
              </div>
              <details className="mt-1.5">
                <summary className="hc-link text-xs cursor-pointer">
                  how to level up
                </summary>
                <ul className="hc-thread-meta text-xs mt-1.5 flex flex-col gap-1">
                  {levelProgress.quests.map((quest) => (
                    <li key={quest.id}>
                      {quest.done ? (
                        <span style={{ color: "var(--hc-greentext)" }}>✓</span>
                      ) : (
                        <span className="opacity-50">☐</span>
                      )}{" "}
                      {quest.label} (+{quest.xp} XP)
                    </li>
                  ))}
                  <li className="opacity-80">
                    ★ every post keeps earning XP (+10 XP each, no limit)
                  </li>
                </ul>
              </details>
            </div>

            <a
              href={`${BLOCK_EXPLORER_URL}/address/${tbaAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hc-link break-all font-mono text-xs"
            >
              {tbaAddress}
            </a>

            <div className="flex flex-wrap gap-2 mt-1">
              <a
                href={`${OPENSEA_ASSET_BASE}/${tokenId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hc-button hc-button-ghost text-xs px-3 py-1.5"
              >
                View on OpenSea ↗
              </a>
              <a
                href={`${BLOCK_EXPLORER_URL}/address/${tbaAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hc-button hc-button-ghost text-xs px-3 py-1.5"
              >
                View on Blockscout ↗
              </a>
            </div>
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

            <WalletActionsPanel
              tokenId={tokenId}
              tbaAddress={tbaAddress}
              initialActivated={activated}
              ethBalanceWei={holdings.ethBalanceWei}
              tokenBalances={holdings.tokenBalances}
            />

            <WalletHoldingsView
              nfts={holdings.nfts}
              tokenBalances={holdings.tokenBalances}
            />
          </>
        )}

        <div className="hc-infobox">
          <div className="hc-infobox-header">
            <span>Post History{postCount > 0 ? ` (${postCount})` : ""}</span>
          </div>
          <div className="hc-infobox-body">
            {posts.length === 0 ? (
              <p className="hc-thread-meta text-sm">
                This anon hasn&apos;t posted yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {posts.map((post) => (
                  <Link
                    key={post.id}
                    href={`/board/${post.threadId}`}
                    className="hc-box block p-2.5 hover:opacity-90"
                  >
                    <div className="hc-thread-meta text-xs mb-1 flex items-center gap-1.5 flex-wrap">
                      <span className="hc-thread-subject truncate">
                        {post.threadSubject ?? "deleted thread"}
                      </span>
                      {post.isAi && (
                        <span className="hc-post-ai-badge">AI</span>
                      )}
                      <span>· {formatPostTime(post.createdAt)}</span>
                    </div>
                    <div className="text-sm">{truncateBody(post.body)}</div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
