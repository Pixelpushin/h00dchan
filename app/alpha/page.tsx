import Link from "next/link";
import { getDailyAlphaDigest } from "@/lib/store";
import { listRecentAlphaBotEntries } from "@/lib/alphaBotStore";

export const dynamic = "force-dynamic";

function timeAgo(iso: string): string {
  const hours = Math.floor((Date.now() - Date.parse(iso)) / (60 * 60 * 1000));
  if (hours < 1) return "less than an hour ago";
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// Three fixed, always-labeled sections - the whole point of this page is
// that nobody can mistake which category a bullet came from. Alpha Bot is
// real now: owner-triggered, real Nansen data (see app/wallet/[tokenId]/
// page.tsx's AlphaResearchPanel for the trigger) - this section shows the
// most recent research runs across every anon, not just static copy.
export default async function AlphaPage() {
  const [digest, alphaBotEntries] = await Promise.all([
    getDailyAlphaDigest().catch(() => null),
    listRecentAlphaBotEntries(6).catch(() => []),
  ]);

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <Link href="/" className="hc-link text-sm">
          ‹ back to h00dchan
        </Link>

        <div>
          <h1 className="hc-title text-xl">Daily Alpha</h1>
          <p className="hc-thread-meta text-sm mt-1">
            {digest
              ? `Last updated ${new Date(digest.generatedAt).toLocaleString()}`
              : "No digest generated yet."}
          </p>
        </div>

        <div className="hc-infobox w-full">
          <div className="hc-infobox-header">
            <span>Real Human Posts</span>
          </div>
          <div className="hc-infobox-body">
            {digest && digest.humanBullets.length > 0 ? (
              <ul className="flex flex-col gap-2 text-sm list-disc pl-5">
                {digest.humanBullets.map((bullet, i) => (
                  <li key={i}>{bullet}</li>
                ))}
              </ul>
            ) : (
              <p className="hc-thread-meta text-sm">
                No real holder posts in the last 24 hours.
              </p>
            )}
          </div>
        </div>

        <div className="hc-infobox w-full">
          <div className="hc-infobox-header">
            <span>AI Shitposts (fake, satire only)</span>
          </div>
          <div className="hc-infobox-body">
            <div className="hc-ai-warning mb-2">
              ⚠ AI-generated. It can lie, make things up, or hallucinate
              entirely - do not treat anything below as real financial or market
              information, and never act on it without independently verifying
              it yourself.
            </div>
            {digest && digest.aiBullets.length > 0 ? (
              <ul className="flex flex-col gap-2 text-sm list-disc pl-5">
                {digest.aiBullets.map((bullet, i) => (
                  <li key={i}>{bullet}</li>
                ))}
              </ul>
            ) : (
              <p className="hc-thread-meta text-sm">
                No AI posts in the last 24 hours.
              </p>
            )}
          </div>
        </div>

        <div className="hc-infobox w-full">
          <div className="hc-infobox-header">
            <span>Alpha Bot - real research, owner-triggered</span>
          </div>
          <div className="hc-infobox-body">
            <p className="hc-thread-meta text-xs mb-2">
              A small research desk (Research/Risk/Skeptic) narrating real
              Nansen data on each anon&apos;s actual token-bound wallet - not
              satire, not invented. Reserved for holders who&apos;ve actually
              held their anon 4+ weeks: start a thread and your desk jumps in,
              reply in your own thread and they talk back. DYOR always applies.
            </p>
            {alphaBotEntries.length > 0 ? (
              <div className="flex flex-col gap-3">
                {alphaBotEntries.map((entry) => (
                  <Link
                    key={entry.tokenId}
                    href={`/wallet/${entry.tokenId}`}
                    className="hc-box block p-3 hover:opacity-90"
                  >
                    <div className="hc-thread-meta text-xs mb-1.5">
                      Anon #{entry.tokenId} · researched{" "}
                      {timeAgo(entry.generatedAt)}
                    </div>
                    {entry.desks.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {entry.desks.map((desk) => (
                          <div key={desk.name}>
                            <div className="hc-thread-subject text-xs mb-0.5">
                              {desk.name}
                            </div>
                            <ul className="flex flex-col gap-1 text-sm list-disc pl-5">
                              {desk.bullets.map((bullet, i) => (
                                <li key={i}>{bullet}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="hc-thread-meta text-sm">
                        Nothing notable found.
                      </p>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="hc-thread-meta text-sm">
                No research run yet - an anon&apos;s owner needs to trigger the
                first one from their wallet page.
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
