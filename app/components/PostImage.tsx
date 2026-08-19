"use client";

import { useMemo, useState } from "react";
import { ipfsGatewayUrls } from "@/lib/chain";

// fallbackSrc (metadata.image, resolved once and cached server-side by
// getOrFetchTokenMetadata - see lib/store.ts) tries FIRST now, not last.
// This used to always start from a live IPFS gateway race and only fall
// back to fallbackSrc after exhausting every candidate - meaning even a
// token whose image had already been permanently backfilled to Vercel
// Blob (fast CDN, see app/api/admin/backfill-images/route.ts) still paid
// a fresh IPFS-gateway round-trip on every single page load, and with
// many of these on one page (a board thread list, a leaderboard),
// resolving independently and slowly, this is exactly what read live as
// "images load one at a time, painfully slow." fallbackSrc is at minimum
// as good as the first raw gateway candidate and often much faster (a
// permanent Blob URL vs. a possibly-flaky live gateway); the raw IPFS
// candidates remain as a resilience fallback if fallbackSrc itself 404s.
export function PostImage({
  rawImageUri,
  fallbackSrc,
  alt,
  className,
}: {
  rawImageUri: string;
  fallbackSrc: string;
  alt: string;
  className?: string;
}) {
  const sources = useMemo(() => {
    const gatewayCandidates = rawImageUri ? ipfsGatewayUrls(rawImageUri) : [];
    return [fallbackSrc, ...gatewayCandidates].filter(Boolean);
  }, [fallbackSrc, rawImageUri]);
  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];

  if (!src) {
    return (
      <div className={className} style={{ background: "var(--hc-box-alt)" }} />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => {
        setAttempt((current) =>
          current + 1 < sources.length ? current + 1 : current,
        );
      }}
    />
  );
}
