"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Classic imageboard-style rotating ad banner, placed the way real 4chan
// places its own: below the "What is X?" info box, above the main content.
// All twelve link to the same place - the actual HOODCHAN OpenSea collection
// - since that's the one call-to-action this site actually wants people to
// take (go get a token to claim). Sliced from 3 stacked-panel sheets via
// scripts' darkest-row seam detection (same technique as the original
// banner set), 4 panels per sheet.
const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/h00dchan";
const BANNER_COUNT = 12;
const ROTATE_MS = 8_000;

function bannerSrc(index: number): string {
  return `/banners/banner-${index + 1}.jpg`;
}

// Mount-gated, same pattern as app/page.tsx's useWalletDetected: SSR has no
// meaningful "random" value to render, so render nothing until mounted
// rather than risk a hydration mismatch (server picks one random index,
// client picks a different one on its own first pass - a real mismatch
// class already hit twice elsewhere in this app). Returning null on both
// the server and the client's pre-hydration pass means there's nothing to
// mismatch; the actual random pick only reaches the DOM after hydration
// completes, when React no longer diffs against server HTML.
function subscribeNoop() {
  return () => {};
}

function useMounted() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

export function AdBanner() {
  const mounted = useMounted();
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * BANNER_COUNT),
  );

  // Rotation lives in a setInterval callback, not the effect body itself -
  // this is the subscribe-to-an-external-timer pattern effects are meant
  // for, not the synchronous-setState-in-effect-body pattern that trips
  // this repo's stricter lint rule elsewhere.
  useEffect(() => {
    const id = setInterval(() => {
      setIndex((current) => {
        if (BANNER_COUNT <= 1) return current;
        let next = Math.floor(Math.random() * BANNER_COUNT);
        while (next === current)
          next = Math.floor(Math.random() * BANNER_COUNT);
        return next;
      });
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  if (!mounted) return null;

  return (
    <a
      href={OPENSEA_COLLECTION_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full mb-6 rounded overflow-hidden border"
      style={{ borderColor: "var(--hc-box-border)" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={bannerSrc(index)}
        alt="HOODCHAN on OpenSea"
        className="w-full h-auto block"
      />
    </a>
  );
}
