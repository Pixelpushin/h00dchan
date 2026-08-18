import Link from "next/link";
import { getOrFetchTokenMetadata, listThreads } from "@/lib/store";
import { NewThreadForm } from "@/app/board/NewThreadForm";
import { PostImage } from "@/app/components/PostImage";

export const dynamic = "force-dynamic";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Metadata is KV-cached forever once resolved (see getOrFetchTokenMetadata),
// so this is Redis reads, not the RPC-heavy fan-out this repo has been
// burned by before - still chunked rather than one unbounded Promise.all
// across the whole board, since that count only grows over time.
const METADATA_CONCURRENCY = 25;

export default async function BoardPage() {
  const threads = await listThreads();
  const sorted = [...threads].sort(
    (a, b) => Date.parse(b.bumpedAt) - Date.parse(a.bumpedAt),
  );

  const metadataByTokenId = new Map<
    string,
    Awaited<ReturnType<typeof getOrFetchTokenMetadata>> | null
  >();
  for (let i = 0; i < sorted.length; i += METADATA_CONCURRENCY) {
    const batch = sorted.slice(i, i + METADATA_CONCURRENCY);
    const results = await Promise.all(
      batch.map((thread) =>
        getOrFetchTokenMetadata(thread.tokenId).catch(() => null),
      ),
    );
    batch.forEach((thread, j) =>
      metadataByTokenId.set(thread.tokenId, results[j]),
    );
  }

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <h1 className="hc-title text-xl">/hc/ - h00dchan</h1>

        <NewThreadForm />

        {sorted.length === 0 && (
          <div className="hc-box p-6 text-center hc-thread-meta">
            No threads yet. Be the first Anon to post.
          </div>
        )}

        <div className="flex flex-col gap-3">
          {sorted.map((thread) => {
            const metadata = metadataByTokenId.get(thread.tokenId) ?? null;
            const rawImageUri =
              metadata && typeof metadata.raw.image === "string"
                ? metadata.raw.image
                : "";
            return (
              <Link
                key={thread.id}
                href={`/board/${thread.id}`}
                className="hc-thread-row flex items-center gap-3"
              >
                {metadata && (
                  <PostImage
                    rawImageUri={rawImageUri}
                    fallbackSrc={metadata.image}
                    alt={metadata.name}
                    className="hc-post-image w-12 h-12 shrink-0 object-cover"
                  />
                )}
                <div className="min-w-0">
                  <div className="hc-thread-subject text-base">
                    {thread.subject}
                  </div>
                  <div className="hc-thread-meta mt-1">
                    Anon #{thread.tokenId} · {thread.replyCount}{" "}
                    {thread.replyCount === 1 ? "reply" : "replies"} · bumped{" "}
                    {formatTime(thread.bumpedAt)}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
