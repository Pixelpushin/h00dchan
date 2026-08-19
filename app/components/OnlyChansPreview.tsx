"use client";

// onlyChans preview card for the home page - same .hc-infobox/grid/"view
// the full board" shape as PopularThreads (app/components/PopularThreads.
// tsx), just below the other board previews rather than up top, and with
// the thumbnails blurred until the connected wallet is confirmed to hold
// HOODCHAN or CHAN (lib/onlychansConfig.ts/app/api/onlychans/is-holder).
// Real image bytes ARE fetched either way (see the preview route's own
// comment on why that's fine for this low-stakes content) - only the
// visual blur is gated, not the network request.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useWalletAddress } from "@/lib/useWalletAddress";

interface PreviewPost {
  id: string;
  imageUrl: string;
}

export function OnlyChansPreview() {
  const address = useWalletAddress();
  const [posts, setPosts] = useState<PreviewPost[]>([]);
  const [isHolder, setIsHolder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/onlychans/preview")
      .then((res) => (res.ok ? res.json() : { posts: [] }))
      .then((body) => {
        if (!cancelled) setPosts(body.posts ?? []);
      })
      .catch(() => {
        if (!cancelled) setPosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (posts.length === 0) return null;

  return (
    <div className="hc-infobox w-full mb-6">
      <div className="hc-infobox-header">
        <span>onlyChans</span>
      </div>
      <div className="hc-infobox-body">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {posts.map((post) => (
            <div key={post.id} className="hc-box block overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={post.imageUrl}
                alt=""
                className="w-full aspect-[2/1] object-cover"
                style={{ filter: isHolder ? undefined : "blur(6px)" }}
              />
            </div>
          ))}
        </div>
        <div className="mt-3 text-center">
          <Link href="/onlychans" className="hc-link text-sm">
            {isHolder
              ? "view the full board ›"
              : "members only - connect & verify to unlock ›"}
          </Link>
        </div>
      </div>
    </div>
  );
}
