import Link from "next/link";
import { computeLeaderboard } from "@/lib/leaderboard";
import { getOrFetchTokenMetadata } from "@/lib/store";
import { PostImage } from "@/app/components/PostImage";

export const dynamic = "force-dynamic";

const DISPLAY_LIMIT = 100;

export default async function LeaderboardPage() {
  const entries = await computeLeaderboard();
  const top = entries.slice(0, DISPLAY_LIMIT);

  const withMetadata = await Promise.all(
    top.map(async (entry) => ({
      entry,
      metadata: await getOrFetchTokenMetadata(entry.tokenId).catch(() => null),
    })),
  );

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <Link href="/" className="hc-link text-sm">
          ‹ back to h00dchan
        </Link>

        <div>
          <h1 className="hc-title text-2xl">Leaderboard</h1>
          <p className="hc-thread-meta text-sm mt-1">
            Ranked by XP - claim your anon, enable its wallet, post and reply to
            climb. Hold without selling for weekly bonus XP (flippers earn
            none), hold other anons for a collector bonus, or stash a HOODCHAN
            inside your own anon&apos;s wallet for a nested-holding bonus. Only
            anons that have claimed or posted at least once are ranked here - a
            wallet-only activation with no other activity won&apos;t show up
            yet.
          </p>
        </div>

        {entries.length === 0 ? (
          <div className="hc-box p-6 text-center hc-thread-meta">
            No ranked anons yet - be the first to claim or post.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {withMetadata.map(({ entry, metadata }, i) => (
              <Link
                key={entry.tokenId}
                href={`/wallet/${entry.tokenId}`}
                className="hc-box flex items-center gap-3 p-2.5 hover:opacity-90"
              >
                <div className="hc-thread-meta text-sm w-7 text-center shrink-0">
                  {i + 1}
                </div>
                {metadata && (
                  <PostImage
                    rawImageUri={
                      typeof metadata.raw.image === "string"
                        ? metadata.raw.image
                        : ""
                    }
                    fallbackSrc={metadata.image}
                    alt={metadata.name}
                    className="hc-post-image w-12 h-12 shrink-0 object-cover"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="hc-thread-subject text-sm truncate">
                    Anon #{entry.tokenId}
                  </div>
                  <div className="hc-thread-meta text-xs flex flex-wrap items-center gap-1.5">
                    <span>{entry.totalXp} XP</span>
                    {entry.claimed && (
                      <span style={{ color: "var(--hc-greentext)" }}>
                        ● claimed
                      </span>
                    )}
                    {entry.isTopHolder && (
                      <span style={{ color: "var(--hc-header-to)" }}>
                        ★ top holder
                      </span>
                    )}
                    {entry.hodlerWeeks > 0 && (
                      <span>💎 {entry.hodlerWeeks}w held</span>
                    )}
                    {entry.nestedHoldingCount > 0 && (
                      <span>
                        📦 {entry.nestedHoldingCount} nested anon
                        {entry.nestedHoldingCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>
                <div
                  className="hc-badge shrink-0"
                  style={{
                    color: "var(--hc-header-to)",
                    borderColor: "var(--hc-header-to)",
                  }}
                >
                  Lv.{entry.level}
                </div>
              </Link>
            ))}
          </div>
        )}

        {entries.length > DISPLAY_LIMIT && (
          <p className="hc-thread-meta text-xs text-center">
            showing top {DISPLAY_LIMIT} of {entries.length} ranked anons
          </p>
        )}
      </main>
    </div>
  );
}
