import Link from "next/link";
import { notFound } from "next/navigation";
import { getThread, listPosts, type Post } from "@/lib/store";
import { fetchTokenMetadata, type TokenMetadata } from "@/lib/chain";
import { PostHeader } from "@/app/components/PostHeader";
import { PostBody } from "@/app/components/PostBody";
import { PostImage } from "@/app/components/PostImage";
import { ReplyForm } from "@/app/board/[threadId]/ReplyForm";

export const dynamic = "force-dynamic";

// Images are resolved from each post's tokenId at render time (never
// duplicated/cached into the post record itself) using the same
// fetchTokenMetadata() the /api/token/[tokenId] route wraps. That route
// exists to route around browser-side IPFS-gateway CORS flakiness (see its
// own comment) - a concern that doesn't apply here since this runs
// server-to-server during SSR, so calling the underlying function directly
// avoids a redundant self-HTTP round trip for the same resolution logic.
async function resolveTokenMetadata(
  tokenIds: string[],
): Promise<Map<string, TokenMetadata | null>> {
  const unique = [...new Set(tokenIds)];
  const entries = await Promise.all(
    unique.map(async (id) => {
      try {
        return [id, await fetchTokenMetadata(id)] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  return new Map(entries);
}

function PostCard({
  post,
  metadata,
  isOp,
}: {
  post: Post;
  metadata: TokenMetadata | null;
  isOp: boolean;
}) {
  const rawImageUri =
    metadata && typeof metadata.raw.image === "string"
      ? metadata.raw.image
      : "";
  return (
    <div className={`hc-post ${isOp ? "hc-post-op" : ""}`}>
      <PostHeader
        tokenId={post.tokenId}
        createdAt={post.createdAt}
        postId={post.id}
      />
      <div
        className={
          isOp
            ? "flex flex-col sm:flex-row gap-3"
            : "flex flex-col sm:flex-row gap-3"
        }
      >
        {metadata && (
          <PostImage
            rawImageUri={rawImageUri}
            fallbackSrc={metadata.image}
            alt={metadata.name}
            className={`hc-post-image object-cover ${isOp ? "w-40 h-40 shrink-0" : "w-20 h-20 shrink-0"}`}
          />
        )}
        <PostBody text={post.body} />
      </div>
    </div>
  );
}

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const thread = await getThread(threadId);
  if (!thread) notFound();

  const posts = await listPosts(threadId);
  const [op, ...replies] = posts;
  const metadataByToken = await resolveTokenMetadata(
    posts.map((p) => p.tokenId),
  );

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <Link href="/board" className="hc-link text-sm">
          ‹ back to board
        </Link>
        <h1 className="hc-title text-xl">{thread.subject}</h1>

        {op && (
          <PostCard
            post={op}
            metadata={metadataByToken.get(op.tokenId) ?? null}
            isOp
          />
        )}

        {replies.length > 0 && (
          <div className="hc-replies flex flex-col gap-3">
            {replies.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                metadata={metadataByToken.get(post.tokenId) ?? null}
                isOp={false}
              />
            ))}
          </div>
        )}

        <ReplyForm threadId={threadId} />
      </main>
    </div>
  );
}
