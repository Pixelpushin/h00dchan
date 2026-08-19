// Next.js App Router loading UI - shown immediately on navigation while
// the page's own async work (lib/leaderboard.ts's computeLeaderboard) is
// still in flight. Without this file, a real wait (the rare true-cold-
// cache case now that computeLeaderboard is stale-while-revalidate) reads
// as a dead/unresponsive click - a blank tab with zero feedback - instead
// of an obviously-loading one.
export default function LeaderboardLoading() {
  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <p className="hc-thread-meta text-sm">‹ back to h00dchan</p>
        <div>
          <h1 className="hc-title text-2xl">Leaderboard</h1>
          <p className="hc-thread-meta text-sm mt-1">Loading...</p>
        </div>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="hc-box h-14 w-full animate-pulse"
              style={{ opacity: 0.5 }}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
