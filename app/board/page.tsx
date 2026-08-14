import Link from "next/link";
import { listThreads } from "@/lib/store";
import { NewThreadForm } from "@/app/board/NewThreadForm";

export const dynamic = "force-dynamic";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function BoardPage() {
  const threads = await listThreads();
  const sorted = [...threads].sort(
    (a, b) => Date.parse(b.bumpedAt) - Date.parse(a.bumpedAt),
  );

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
          {sorted.map((thread) => (
            <Link
              key={thread.id}
              href={`/board/${thread.id}`}
              className="hc-thread-row block"
            >
              <div className="hc-thread-subject text-base">
                {thread.subject}
              </div>
              <div className="hc-thread-meta mt-1">
                Anon #{thread.tokenId} · {thread.replyCount}{" "}
                {thread.replyCount === 1 ? "reply" : "replies"} · bumped{" "}
                {formatTime(thread.bumpedAt)}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
