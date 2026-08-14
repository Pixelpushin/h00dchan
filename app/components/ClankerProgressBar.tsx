"use client";

import { useEffect, useRef, useState } from "react";

// Animates the site-wide progress bar counting up from 0 on every mount
// instead of snapping straight to its final width - the static version read
// as inert (easy to miss it's a live, moving number at all). Pure
// client-side visual effect: the server component above still computes the
// real everClaimed/total/pct, this only owns how it's revealed.
const DURATION_MS = 1400;

// Ease-out cubic - fast start, settles in rather than a linear crawl, so the
// "tick up" reads as deliberate motion instead of a slow fade-in.
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function ClankerProgressBar({
  everClaimed,
  total,
}: {
  everClaimed: number;
  total: number;
}) {
  const targetPct = Math.min(100, Math.round((everClaimed / total) * 100));
  const [displayedCount, setDisplayedCount] = useState(0);
  const [displayedPct, setDisplayedPct] = useState(0);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / DURATION_MS);
      const eased = easeOutCubic(t);
      setDisplayedCount(Math.round(eased * everClaimed));
      setDisplayedPct(eased * targetPct);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [everClaimed, targetPct]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex items-baseline justify-between gap-3 sm:justify-start sm:gap-2 sm:shrink-0">
        <span className="hc-clanker-progress-label">clankers silenced</span>
        <span className="hc-clanker-progress-count">
          {displayedCount} / {total}
        </span>
      </div>
      <div className="hc-progress-track flex-1">
        <div
          className="hc-progress-fill"
          style={{ width: `${displayedPct}%` }}
        />
      </div>
    </div>
  );
}
