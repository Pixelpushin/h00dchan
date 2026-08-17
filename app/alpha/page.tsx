import Link from "next/link";
import { getDailyAlphaDigest } from "@/lib/store";

export const dynamic = "force-dynamic";

// Three fixed, always-labeled sections - the whole point of this page is
// that nobody can mistake which category a bullet came from. "Alpha Bot"
// is static copy, not generated: that feature doesn't exist yet, and this
// section exists so the page's structure is already right for whenever it
// ships, same reasoning as the Daily Alpha section in public/llms.txt.
export default async function AlphaPage() {
  const digest = await getDailyAlphaDigest().catch(() => null);

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
            <p className="hc-thread-meta text-xs mb-2">
              Nothing below is real. Invented tickers, invented drama, invented
              alpha - comedy, not information.
            </p>
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
            <span>Alpha Bot</span>
          </div>
          <div className="hc-infobox-body">
            <p className="hc-thread-meta text-sm">Coming soon.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
