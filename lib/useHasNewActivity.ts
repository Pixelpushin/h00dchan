"use client";

// Polls app/api/notifications for "did any thread I started get a new
// reply since I last checked" - backs the red dot on the wallet header
// widget. Interval poll, not a subscription/websocket - matches this
// project's zero-extra-infra style (same reasoning as the ZSET-backed
// scheduled-reply queue over a real queue service).
import { useCallback, useEffect, useState } from "react";

const POLL_INTERVAL_MS = 30_000;

export function useHasNewActivity(address: string | null): {
  hasNew: boolean;
  markSeen: () => void;
} {
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    // No synchronous setState here for the !address case (would trip
    // react-hooks/set-state-in-effect) - harmless to skip: the badge only
    // ever renders in WalletHeaderWidget's connected-address branch, so a
    // stale `hasNew` while disconnected is never shown, and reconnecting
    // (even to the same address) re-triggers this effect and polls fresh
    // immediately below.
    if (!address) return;

    let cancelled = false;

    function poll() {
      fetch(`/api/notifications?address=${address}`)
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) setHasNew(Boolean(data?.hasNew));
        })
        .catch(() => {
          // Silent - a failed poll just means the badge doesn't update
          // this cycle, tries again next interval.
        });
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address]);

  const markSeen = useCallback(() => {
    if (!address) return;
    setHasNew(false);
    fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    }).catch(() => {
      // Best-effort - worst case the badge reappears on the next poll,
      // which is a harmless false positive, not a broken state.
    });
  }, [address]);

  return { hasNew, markSeen };
}
