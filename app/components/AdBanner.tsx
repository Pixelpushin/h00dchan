"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Classic imageboard-style rotating ad banner, placed the way real 4chan
// places its own: below the "What is X?" info box, above the main content.
// The 12 house banners link to HOODCHAN's own OpenSea collection; any paid
// ads (see lib/adStore.ts/app/api/ads/route.ts) are mixed into the same
// rotation, each linking to its own advertiser's collection instead. If
// there are zero paid ads the behavior is unchanged - house banners only.
const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/h00dchan";
const HOUSE_BANNER_COUNT = 12;
const ROTATE_MS = 8_000;

export interface PaidAd {
  id: string;
  name: string;
  imageUrl: string;
  openseaUrl: string;
}

interface Entry {
  src: string;
  href: string;
  alt: string;
}

function buildEntries(paidAds: PaidAd[]): Entry[] {
  const house: Entry[] = Array.from({ length: HOUSE_BANNER_COUNT }, (_, i) => ({
    src: `/banners/banner-${i + 1}.jpg`,
    href: OPENSEA_COLLECTION_URL,
    alt: "HOODCHAN on OpenSea",
  }));
  const paid: Entry[] = paidAds.map((ad) => ({
    src: ad.imageUrl,
    href: ad.openseaUrl,
    alt: ad.name,
  }));
  return [...house, ...paid];
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

export function AdBanner({ paidAds = [] }: { paidAds?: PaidAd[] }) {
  const mounted = useMounted();
  const entries = buildEntries(paidAds);
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * entries.length),
  );

  // Rotation lives in a setInterval callback, not the effect body itself -
  // this is the subscribe-to-an-external-timer pattern effects are meant
  // for, not the synchronous-setState-in-effect-body pattern that trips
  // this repo's stricter lint rule elsewhere.
  useEffect(() => {
    const id = setInterval(() => {
      setIndex((current) => {
        if (entries.length <= 1) return current;
        let next = Math.floor(Math.random() * entries.length);
        while (next === current)
          next = Math.floor(Math.random() * entries.length);
        return next;
      });
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [entries.length]);

  if (!mounted) return null;

  const entry = entries[Math.min(index, entries.length - 1)];

  return (
    <a
      href={entry.href}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full mb-6 overflow-hidden rounded border"
      style={{
        borderColor: "var(--hc-box-border)",
        // Fixed aspect ratio (not just h-auto) so the box never changes
        // size between rotations - the 12 house crops range from 155px to
        // 237px tall at this width, which was visibly jumping the layout
        // every 8s, and a paid ad's own OpenSea banner can be any shape.
        // object-fit: contain (not cover) means it always letterboxes
        // instead of ever cropping content.
        aspectRatio: "1168 / 198",
        background: "#000",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={entry.src}
        alt={entry.alt}
        className="block h-full w-full object-contain"
      />
    </a>
  );
}
