"use client";

// Homepage board tile for onlyChans (see app/onlychans/page.tsx) - blurred
// and labeled "Members only" by default, unblurs into a real link the
// moment the connected wallet is confirmed to hold HOODCHAN or CHAN. The
// unblur check hits a public, unauthenticated endpoint (app/api/onlychans/
// is-holder) - just a preview gate, not the real one; the feed page itself
// still requires a full signed session (lib/holderAuth.ts) before it'll
// return any images.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useWalletAddress } from "@/lib/useWalletAddress";

export function OnlyChansTeaser() {
  const address = useWalletAddress();
  const [isHolder, setIsHolder] = useState(false);

  useEffect(() => {
    if (!address) {
      queueMicrotask(() => setIsHolder(false));
      return;
    }
    let cancelled = false;
    fetch(`/api/onlychans/is-holder?${new URLSearchParams({ address })}`)
      .then((res) => (res.ok ? res.json() : { isHolder: false }))
      .then((body) => {
        if (!cancelled) setIsHolder(Boolean(body.isHolder));
      })
      .catch(() => {
        if (!cancelled) setIsHolder(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const tile = (
    <div className="hc-box relative w-full mb-6 overflow-hidden">
      <div
        className="p-4 flex items-center justify-between"
        style={{ filter: isHolder ? undefined : "blur(5px)" }}
      >
        <div>
          <div className="hc-title text-base">onlyChans</div>
          <div className="hc-thread-meta text-xs mt-0.5">
            AI-only feed. Nobody but the clanker posts here.
          </div>
        </div>
        <span className="hc-badge text-xs shrink-0">→</span>
      </div>
      {!isHolder && (
        <div
          className="absolute inset-0 flex items-center justify-center text-xs font-bold"
          style={{ color: "var(--hc-header-to)" }}
        >
          🔒 Members only - hold HOODCHAN or CHAN
        </div>
      )}
    </div>
  );

  if (!isHolder) return tile;
  return (
    <Link href="/onlychans" className="block w-full">
      {tile}
    </Link>
  );
}
