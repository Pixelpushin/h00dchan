"use client";

// Browse-all-sires page - reads BreedingController listings via
// /api/listings (which does the raw JSON-RPC reads + SiringListed log
// enumeration server-side - see that route's own header for the
// enumeration tradeoff).
import { useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits } from "ethers";
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";
import type { ListingResponse } from "@/app/api/listings/route";

type LoadState = "loading" | "ready" | "pending" | "error";

export default function HomePage() {
  const [listings, setListings] = useState<ListingResponse[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/listings")
      .then((res) => res.json())
      .then(
        (data: {
          pending: boolean;
          listings: ListingResponse[];
          error?: string;
        }) => {
          if (cancelled) return;
          if (data.pending) {
            setState("pending");
            return;
          }
          if (data.error) {
            setError(data.error);
            setState("error");
            return;
          }
          setListings(data.listings);
          setState("ready");
        },
      )
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load listings.",
        );
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-5xl w-full px-4 py-6 flex flex-col gap-4">
      <div>
        <h1 className="hc-title text-2xl">Sire-listed anons</h1>
        <p className="text-sm mt-1" style={{ color: "var(--hc-muted)" }}>
          Every HOODCHAN currently listed for siring. Pick a stud, pair him with
          one of your Girlfriends, and see what comes out.
        </p>
      </div>

      {state === "pending" && (
        <ConfigPendingNotice what="The BreedingController contract" />
      )}

      {state === "error" && <div className="hc-error-box">{error}</div>}

      {state === "loading" && (
        <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
          Loading sire listings...
        </p>
      )}

      {state === "ready" && listings.length === 0 && (
        <div
          className="hc-box p-6 text-center text-sm"
          style={{ color: "var(--hc-muted)" }}
        >
          No anons are listed for siring right now. Owners set a price from the
          &quot;my girls&quot; page.
        </div>
      )}

      {state === "ready" && listings.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {listings.map((listing) => (
            <Link
              key={listing.hoodchanId}
              href={`/breed/${listing.hoodchanId}`}
              className="hc-card"
            >
              {listing.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={listing.image}
                  alt={listing.name}
                  className="w-full aspect-square object-cover"
                />
              ) : (
                <div
                  className="w-full aspect-square"
                  style={{ background: "var(--hc-box-alt)" }}
                />
              )}
              <div className="hc-card-body">
                <span className="font-bold text-sm truncate">
                  {listing.name}
                </span>
                <div className="flex flex-wrap gap-1">
                  <span className="hc-badge hc-badge-chan">
                    {formatUnits(listing.chanPrice, 18)} CHAN
                  </span>
                  {listing.ethEligible && (
                    <span className="hc-badge hc-badge-eth">
                      {formatUnits(listing.ethPrice, 18)} ETH
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
