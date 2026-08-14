"use client";

import { useState } from "react";
import { ipfsGatewayUrls } from "@/lib/chain";

// Same gateway-retry approach as the token grid's TokenImage (app/page.tsx)
// - individual IPFS gateways are observably flaky even when the underlying
// content is available, so cycling through the ordered list on load
// failure beats giving up after the first one.
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
  const candidates = rawImageUri ? ipfsGatewayUrls(rawImageUri) : [];
  const [attempt, setAttempt] = useState(0);
  const src = candidates[attempt] ?? fallbackSrc;

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
          current + 1 < candidates.length ? current + 1 : current,
        );
      }}
    />
  );
}
