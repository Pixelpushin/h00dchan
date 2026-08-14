// Classic imageboard post header line: a name (default "Anonymous"), the
// "Anon #<tokenId>" identity number, a timestamp, then a post number.
function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function PostHeader({
  tokenId,
  createdAt,
  postId,
}: {
  tokenId: string;
  createdAt: string;
  postId: string;
}) {
  return (
    <div className="hc-post-header">
      <span className="hc-post-name">Anonymous</span>{" "}
      <span className="hc-post-tokenid">Anon #{tokenId}</span>{" "}
      <span className="hc-post-time">{formatTime(createdAt)}</span>{" "}
      <span className="hc-post-num">No.{postId}</span>
    </div>
  );
}
