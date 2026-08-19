import Link from "next/link";

export const metadata = {
  title: "Developers - h00dchan",
  description: "Public HOODCHAN API - metadata, images, wallets, leaderboard.",
};

interface Endpoint {
  method: string;
  path: string;
  summary: string;
  example: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/collection",
    summary: "Contract address, chain info, total supply.",
    example: "curl https://www.hoodchan.org/api/v1/collection",
  },
  {
    method: "GET",
    path: "/api/v1/token/{tokenId}",
    summary:
      "One anon's full public record: metadata, permanent image URL, token-bound wallet address + activation status, level/XP breakdown.",
    example: "curl https://www.hoodchan.org/api/v1/token/1",
  },
  {
    method: "GET",
    path: "/api/v1/tokens?start=1&count=50",
    summary:
      "Paginated tokenId/name/image list for a gallery - lightweight, no wallet/level data.",
    example: "curl https://www.hoodchan.org/api/v1/tokens?start=1&count=50",
  },
  {
    method: "GET",
    path: "/api/v1/leaderboard?limit=100",
    summary: "Anons ranked by XP.",
    example: "curl https://www.hoodchan.org/api/v1/leaderboard?limit=100",
  },
  {
    method: "GET",
    path: "/api/v1/wallet/{address}",
    summary: "Which HOODCHAN tokens a given address currently holds.",
    example: "curl https://www.hoodchan.org/api/v1/wallet/0xYourAddressHere",
  },
];

export default function DevelopersPage() {
  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-6 px-6 py-8">
        <Link href="/" className="hc-link text-sm">
          ‹ back to h00dchan
        </Link>

        <div>
          <h1 className="hc-title text-2xl">Developers</h1>
          <p className="hc-thread-meta text-sm mt-1">
            Free, public, read-only. No API key, no signup, CORS-open (call it
            straight from your own site&apos;s browser JS). Rate limited to 120
            requests / 5 minutes per IP - plenty for a real app, not enough for
            a runaway loop.
          </p>
        </div>

        <div className="hc-box p-4 flex flex-col gap-2">
          <div className="hc-thread-subject text-sm">Full spec</div>
          <a
            href="/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            className="hc-link text-sm break-all"
          >
            /openapi.json
          </a>
          <p className="hc-thread-meta text-xs">
            OpenAPI 3.1 - drop the URL into any API client, codegen tool, or AI
            coding assistant to get typed requests for free.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {ENDPOINTS.map((endpoint) => (
            <div key={endpoint.path} className="hc-box p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="hc-badge shrink-0"
                  style={{
                    color: "var(--hc-greentext)",
                    borderColor: "var(--hc-greentext)",
                  }}
                >
                  {endpoint.method}
                </span>
                <code className="hc-thread-subject text-sm break-all">
                  {endpoint.path}
                </code>
              </div>
              <p className="hc-thread-meta text-sm">{endpoint.summary}</p>
              <pre className="hc-box p-2 text-xs overflow-x-auto">
                <code>{endpoint.example}</code>
              </pre>
            </div>
          ))}
        </div>

        <div className="hc-box p-4 flex flex-col gap-2">
          <div className="hc-thread-subject text-sm">Images</div>
          <p className="hc-thread-meta text-sm">
            Every token&apos;s <code>image</code> field is a permanent CDN URL
            once backfilled (not a live IPFS gateway fetch) - fast, stable, safe
            to hotlink directly in an <code>&lt;img&gt;</code> tag or cache
            aggressively on your end.
          </p>
        </div>

        <div className="hc-box p-4 flex flex-col gap-2">
          <div className="hc-thread-subject text-sm">
            Machine-readable overview
          </div>
          <p className="hc-thread-meta text-sm">
            <a href="/llms.txt" className="hc-link">
              /llms.txt
            </a>{" "}
            - a plain-text summary of the whole project (what&apos;s real vs.
            satire, the leveling system, this API) written for an LLM/AI agent
            to fetch directly.
          </p>
        </div>
      </main>
    </div>
  );
}
