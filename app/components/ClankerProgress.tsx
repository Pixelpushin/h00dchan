import { getClaimStats } from "@/lib/store";
import { ClankerProgressBar } from "@/app/components/ClankerProgressBar";

// Site-wide, always-visible - deliberately NOT inside the dismissible
// WhatIsHoodchan info box (it used to be, which meant dismissing the
// explainer also hid this). A server component, not a client fetch: this
// value changes slowly (claims are occasional events, not per-second), and
// every full page load already re-renders the shared layout server-side, so
// there's no need for client JS/polling here - reuses the same
// getClaimStats() the /api/stats route wraps, no redundant self-fetch. The
// actual numbers/fill are handed off to a small client component so the bar
// can animate a visible tick-up on mount instead of rendering its final
// state instantly.
export async function ClankerProgress() {
  const stats = await getClaimStats().catch(() => null);
  if (!stats) return null;

  return (
    <div className="hc-clanker-progress">
      <ClankerProgressBar everClaimed={stats.everClaimed} total={stats.total} />
    </div>
  );
}
