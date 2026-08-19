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
  avatarUrl: string;
  openseaUrl: string;
}

interface Entry {
  src: string;
  href: string;
  alt: string;
  // Only set for paid ads - house banners are pre-cropped to fill the box
  // exactly, so they never need the letterbox label. An advertiser's own
  // banner_image_url can be almost any aspect ratio, so object-fit: contain
  // regularly leaves black pillars on the sides - label/avatar here is
  // that unused space put to use instead of just sitting empty.
  label?: { name: string; avatarUrl: string };
}

// Confirmed live as a real problem: 1 paid ad mixed evenly into 12 house
// banners meant a 1-in-13 chance of ever actually showing per rotation -
// someone who just paid for a slot had roughly the same odds of seeing
// their own ad as any random visitor. Paid ads now collectively get equal
// weight to the whole house pool (50/50), split evenly across however many
// paid ads are active - achieved by duplicating each paid ad's entry
// enough times in the flat array to hit that share, so the existing
// random-index-into-flat-array rotation logic below needs no other
// changes.
function buildEntries(paidAds: PaidAd[]): Entry[] {
  const house: Entry[] = Array.from({ length: HOUSE_BANNER_COUNT }, (_, i) => ({
    src: `/banners/banner-${i + 1}.jpg`,
    href: OPENSEA_COLLECTION_URL,
    alt: "HOODCHAN on OpenSea",
  }));
  if (paidAds.length === 0) return house;

  const slotsPerPaidAd = Math.max(
    1,
    Math.round(HOUSE_BANNER_COUNT / paidAds.length),
  );
  const paid: Entry[] = paidAds.flatMap((ad) =>
    Array.from({ length: slotsPerPaidAd }, () => ({
      src: ad.imageUrl,
      href: ad.openseaUrl,
      alt: ad.name,
      label: { name: ad.name, avatarUrl: ad.avatarUrl },
    })),
  );
  return [...house, ...paid];
}

// Some advertisers' OpenSea banners are animated GIFs, and some of those
// cycle fast enough to be a genuine flashing-lights problem (reported live:
// "could give you a seizure"). CSS can't slow down a GIF's own embedded
// frame timing, so instead this grabs a single still frame via canvas the
// moment the image finishes loading and displays that in place of the live
// animation - same visual as a static banner, zero flashing. Falls back to
// the raw animated src if the canvas read fails (e.g. the CDN doesn't send
// permissive CORS headers) rather than showing nothing.
function isLikelyAnimated(src: string): boolean {
  const path = src.split("?")[0].split("#")[0];
  return /\.gif$/i.test(path);
}

function StillFrameImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [frozenSrc, setFrozenSrc] = useState<string | null>(null);

  // Keyed by src at the call site (see below) so this component remounts -
  // and frozenSrc naturally starts at null again - whenever the entry
  // being displayed changes, instead of needing a synchronous reset here.
  useEffect(() => {
    if (!isLikelyAnimated(src)) return;

    let cancelled = false;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        setFrozenSrc(canvas.toDataURL("image/png"));
      } catch {
        // Tainted canvas (no CORS) or other read failure - leave frozenSrc
        // null, which falls through to rendering the live src below.
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={frozenSrc ?? src} alt={alt} className={className} />;
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

export function AdBanner({
  paidAds = [],
  randomTokenPool = [],
}: {
  paidAds?: PaidAd[];
  randomTokenPool?: Array<{ tokenId: string; imageUrl: string }>;
}) {
  const mounted = useMounted();
  const entries = buildEntries(paidAds);
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * entries.length),
  );

  // A fresh random pair from the pool every time the ad rotates (index
  // changes) - "random selection... that cycle and change," not the same
  // two tokens fixed for the whole session. Lives in an effect (the
  // subscribe-and-setState pattern this file already uses for the
  // rotation timer itself), not a useMemo - Math.random() during render
  // (including inside useMemo, which still runs in the render phase)
  // trips this repo's stricter purity lint rule.
  const [[flankLeft, flankRight], setFlankPair] = useState<
    readonly [
      { tokenId: string; imageUrl: string } | undefined,
      { tokenId: string; imageUrl: string } | undefined,
    ]
  >([undefined, undefined]);
  useEffect(() => {
    // queueMicrotask: this repo's lint rule flags setState called
    // synchronously in an effect body even when the effect's own
    // dependencies (not an external subscription) are what triggered it -
    // same fix pattern used elsewhere in this session (WalletHeaderWidget,
    // collection/page.tsx).
    queueMicrotask(() => {
      if (randomTokenPool.length === 0) {
        setFlankPair([undefined, undefined]);
        return;
      }
      if (randomTokenPool.length === 1) {
        setFlankPair([randomTokenPool[0], randomTokenPool[0]]);
        return;
      }
      const i = Math.floor(Math.random() * randomTokenPool.length);
      let j = Math.floor(Math.random() * randomTokenPool.length);
      while (j === i) j = Math.floor(Math.random() * randomTokenPool.length);
      setFlankPair([randomTokenPool[i], randomTokenPool[j]]);
    });
  }, [index, randomTokenPool]);

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
      className="relative block w-full mb-6 overflow-hidden rounded border"
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
      {entry.label ? (
        // Paid ads: flanked by the collection's two rarest anons (rank 1
        // and 2 on the rarity index) instead of plain black pillars - a
        // real advertiser banner's own aspect ratio rarely matches this
        // ultra-wide 1168:198 slot, so object-contain was leaving that
        // space empty. Purely decorative (not linked - the whole banner is
        // already one <a>, and a nested <a> inside it would be invalid
        // HTML), same treatment on every paid ad regardless of whether
        // this specific one happens to fill the frame or not, for a
        // consistent look slot to slot.
        <div className="flex h-full w-full">
          {flankLeft && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={flankLeft.imageUrl}
              alt=""
              className="h-full w-[16%] shrink-0 object-cover"
            />
          )}
          <div className="relative h-full flex-1 min-w-0">
            <StillFrameImage
              key={entry.src}
              src={entry.src}
              alt={entry.alt}
              className="block h-full w-full object-contain"
            />
            {/* Pinned to the bottom-left corner of the ad's own image
                area (not the whole banner) - works whether this specific
                ad letterboxes within its slice or fills it exactly. */}
            <div
              className="absolute left-2 bottom-2 flex items-center gap-2 rounded px-2 py-1.5"
              style={{ background: "rgba(0,0,0,0.72)" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={entry.label.avatarUrl}
                alt=""
                className="h-9 w-9 rounded-sm object-cover shrink-0"
              />
              <span className="text-base font-semibold text-white truncate max-w-[14rem]">
                {entry.label.name}
              </span>
            </div>
          </div>
          {flankRight && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={flankRight.imageUrl}
              alt=""
              className="h-full w-[16%] shrink-0 object-cover"
            />
          )}
        </div>
      ) : (
        <StillFrameImage
          key={entry.src}
          src={entry.src}
          alt={entry.alt}
          className="block h-full w-full object-contain"
        />
      )}
    </a>
  );
}
