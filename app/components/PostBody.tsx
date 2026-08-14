// Greentext: classic imageboard convention where any line starting with
// ">" renders in green (sarcasm/anecdote markup). Implemented as a plain
// per-line text rule, not a markdown parser - React renders each segment
// as text (never dangerouslySetInnerHTML), so this can't introduce an XSS
// vector no matter what a post body contains.
export function PostBody({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <p className="hc-post-body">
      {lines.map((line, i) => (
        <span
          key={i}
          className={line.startsWith(">") ? "hc-greentext" : undefined}
        >
          {line}
          {i < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  );
}
