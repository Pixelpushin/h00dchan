import Link from "next/link";
import { getOrFetchTokenMetadata, type ThreadWithCounts } from "@/lib/store";
import { PostImage } from "@/app/components/PostImage";

// Front-page preview for logged-out visitors - previously the home page
// showed nothing but a "Connect Wallet" button until you connected, which
// meant a first-time visitor with no wallet ready saw an empty page instead
// of any of the actual board content. Real imageboards (4chan's own front
// page, in particular) lead with a "Popular Threads" panel; this is the
// same idea scaled down to the one board this site actually has - no tab
// UI needed for a single board, just the thread list itself.
const PREVIEW_COUNT = 6;

// Takes the full thread list as a prop rather than calling listThreads()
// itself - this used to fetch independently, which meant every home page
// load ran the full (expensive, per-thread) board scan twice, once here
// and once in the sibling HumanThreads component. app/page.tsx now fetches
// once and hands the same array to both.
export async function PopularThreads({
  threads,
}: {
  threads: ThreadWithCounts[];
}) {
  if (threads.length === 0) return null;

  const popular = [...threads]
    .sort((a, b) => {
      if (b.replyCount !== a.replyCount) return b.replyCount - a.replyCount;
      return Date.parse(b.bumpedAt) - Date.parse(a.bumpedAt);
    })
    .slice(0, PREVIEW_COUNT);

  const withThumbnails = await Promise.all(
    popular.map(async (thread) => ({
      thread,
      metadata: await getOrFetchTokenMetadata(thread.tokenId).catch(() => null),
    })),
  );

  return (
    <div className="hc-infobox w-full mb-6">
      <div className="hc-infobox-header">
        <span>Popular Threads</span>
      </div>
      <div className="hc-infobox-body">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {withThumbnails.map(({ thread, metadata }) => {
            const rawImageUri =
              metadata && typeof metadata.raw.image === "string"
                ? metadata.raw.image
                : "";
            return (
              <Link
                key={thread.id}
                href={`/board/${thread.id}`}
                className="hc-box block overflow-hidden"
              >
                {metadata && (
                  <PostImage
                    rawImageUri={rawImageUri}
                    fallbackSrc={metadata.image}
                    alt={metadata.name}
                    className="w-full aspect-[2/1] object-cover"
                  />
                )}
                <div className="p-2">
                  <div className="hc-thread-subject text-sm truncate">
                    {thread.subject}
                  </div>
                  <div className="hc-thread-meta">
                    Anon #{thread.tokenId} ·{" "}
                    {thread.replyCount === 1
                      ? "1 reply"
                      : `${thread.replyCount} replies`}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
        <div className="mt-3 text-center">
          <Link href="/board" className="hc-link text-sm">
            view the full board ›
          </Link>
        </div>
      </div>
    </div>
  );
}
