import Link from "next/link";
import {
  getOrFetchTokenMetadata,
  isThreadHuman,
  type ThreadWithCounts,
} from "@/lib/store";
import { PostImage } from "@/app/components/PostImage";

// Sits alongside PopularThreads on the home page - that one ranks by reply
// count, which buries a thread someone *just* posted until it gets
// engagement. This one shows the most recent human-started threads
// specifically, most recent first, so posting gives real-time visible
// feedback: "yes, my thread is really up there" - not "wait and see if it
// becomes popular."
const PREVIEW_COUNT = 6;
// Bound how many recent threads get the isThreadHuman() check (2 extra
// store reads each) rather than checking the entire board's history on
// every home page load.
const SCAN_LIMIT = 30;

// Takes the full thread list as a prop - see PopularThreads.tsx's comment,
// same dedup, same reason.
export async function HumanThreads({
  threads,
}: {
  threads: ThreadWithCounts[];
}) {
  if (threads.length === 0) return null;

  const recentCandidates = [...threads]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, SCAN_LIMIT);

  const humanFlags = await Promise.all(
    recentCandidates.map((thread) =>
      isThreadHuman(thread.id).catch(() => false),
    ),
  );
  const human = recentCandidates
    .filter((_, i) => humanFlags[i])
    .slice(0, PREVIEW_COUNT);

  if (human.length === 0) return null;

  const withThumbnails = await Promise.all(
    human.map(async (thread) => ({
      thread,
      metadata: await getOrFetchTokenMetadata(thread.tokenId).catch(() => null),
    })),
  );

  return (
    <div className="hc-infobox w-full mb-6">
      <div className="hc-infobox-header">
        <span>Threads From Real Holders</span>
      </div>
      <div className="hc-infobox-body">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {withThumbnails.map(({ thread, metadata }) => {
            const rawImageUri =
              metadata && typeof metadata.raw.image === "string"
                ? metadata.raw.image
                : "";
            return (
              <div key={thread.id} className="hc-box overflow-hidden">
                {metadata && (
                  <Link href={`/wallet/${thread.tokenId}`} className="block">
                    <PostImage
                      rawImageUri={rawImageUri}
                      fallbackSrc={metadata.image}
                      alt={metadata.name}
                      className="w-full aspect-[2/1] object-cover"
                    />
                  </Link>
                )}
                <Link href={`/board/${thread.id}`} className="block p-2">
                  <div className="hc-thread-subject text-sm truncate">
                    {thread.subject}
                  </div>
                  <div className="hc-thread-meta">
                    Anon #{thread.tokenId} ·{" "}
                    {thread.replyCount === 1
                      ? "1 reply"
                      : `${thread.replyCount} replies`}
                  </div>
                </Link>
              </div>
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
