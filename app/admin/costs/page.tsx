"use client";

// Private cost overview - every paid API/service this app depends on, kept
// out of the public llms.txt on purpose (that file is fetched by anyone/
// any AI agent with no auth; real spend numbers there would hand
// competitors a look at margins for no real benefit to a site visitor).
// Same wallet-whitelist gate as every other admin page.
//
// Figures below are pricing MODELS and rough per-unit costs, not a live
// billing pull - nothing here hits a provider's billing API, so treat the
// dollar amounts as ballpark, not audited. Each row links to the real
// dashboard for actual current spend.
import { useAdminSession } from "@/lib/useAdminSession";

interface CostRow {
  service: string;
  usedFor: string;
  pricingModel: string;
  estimate: string;
  costControl: string;
  dashboardUrl: string;
}

const ROWS: CostRow[] = [
  {
    service: "Vercel",
    usedFor:
      "Hosting, cron jobs, Blob storage (NFT/onlyChans images), KV/Redis",
    pricingModel:
      "Plan + usage overages (bandwidth, function invocations, Blob storage/bandwidth)",
    estimate: "Depends on plan tier - check dashboard for real usage",
    costControl:
      "No built-in cap - the account's plan/spend limit is the only ceiling",
    dashboardUrl: "https://vercel.com/dashboard/usage",
  },
  {
    service: "Venice AI",
    usedFor:
      "AI shitposts for unclaimed anons, scheduled thread replies, daily alpha digest",
    pricingModel: "Usage-based, per-token",
    estimate: "Not independently verified - check Venice billing dashboard",
    costControl:
      "Scheduled-reply cron only spends when a reply is actually due (queue processor, not a blind timer)",
    dashboardUrl: "https://venice.ai/",
  },
  {
    service: "OpenAI (images)",
    usedFor:
      'onlyChans post generation (gpt-image-1, "low" quality, 1024x1024)',
    pricingModel: "Per image, tiered by quality/size",
    estimate:
      "Roughly $0.01-0.02/image at low quality (approximate - verify current rate on OpenAI's pricing page)",
    costControl:
      'Quality forced to "low", cron fires twice/day only (2 images/day cap), no user-triggered generation exists',
    dashboardUrl: "https://platform.openai.com/usage",
  },
  {
    service: "Nansen",
    usedFor: "Alpha Bot wallet research (Profiler current-balance + labels)",
    pricingModel: "Credit-based per call (plan-dependent credit pool)",
    estimate:
      "Not independently verified for the Profiler endpoints specifically - check response headers/dashboard",
    costControl:
      "24h cooldown per anon, owner-signature-gated trigger only (no cron, no blind sweep of all 1197 tokens)",
    dashboardUrl: "https://app.nansen.ai/api",
  },
  {
    service: "Alchemy",
    usedFor:
      "Robinhood Chain RPC (leaderboard, holder checks) + NFT/token balance API (wallet explorer)",
    pricingModel: "Compute-unit based, generous free tier",
    estimate: "Likely within free tier at current volume - check dashboard",
    costControl:
      "Retry-with-backoff, not retry-forever; no per-request user action multiplies this",
    dashboardUrl: "https://dashboard.alchemy.com/",
  },
  {
    service: "OpenSea API",
    usedFor: "Ad-rental collection lookups (pulls official banner art)",
    pricingModel: "Free tier for this call volume",
    estimate: "$0 at current volume",
    costControl: "Only called on ad submission, not on a timer",
    dashboardUrl: "https://docs.opensea.io/reference/api-keys",
  },
  {
    service: "Pinata",
    usedFor: "Dedicated IPFS gateway for NFT images",
    pricingModel: "Fixed monthly gateway plan (already provisioned)",
    estimate: "Fixed recurring - check Pinata billing for the plan amount",
    costControl: "Flat plan, not usage-metered per request",
    dashboardUrl: "https://app.pinata.cloud/billing",
  },
  {
    service: "Reown (WalletConnect)",
    usedFor: "Wallet connect modal (AppKit)",
    pricingModel: "Free tier typically sufficient at this project's scale",
    estimate: "$0 at current volume",
    costControl: "n/a - free tier",
    dashboardUrl: "https://cloud.reown.com/",
  },
  {
    service: "X (Twitter) API",
    usedFor: "Bio verification lookups for the X-account-linking feature",
    pricingModel:
      "Pay-per-use, ~$0.01/user lookup (verified via research earlier this build)",
    estimate: "~$2/month at the current bi-weekly recheck cadence",
    costControl:
      "Recheck cron runs every 2 weeks, not more often - deliberately budgeted",
    dashboardUrl: "https://developer.x.com/en/portal/dashboard",
  },
];

export default function AdminCostsPage() {
  const { session, connecting, connectError, connect } = useAdminSession();

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="hc-box flex flex-col gap-3 p-4 w-full max-w-sm text-center">
          <p className="hc-thread-meta text-xs">
            Connect and sign with a whitelisted admin wallet.
          </p>
          <button onClick={connect} disabled={connecting} className="hc-button">
            {connecting ? "Connecting..." : "Connect Wallet"}
          </button>
          {connectError && (
            <p className="text-sm" style={{ color: "#a12b2b" }}>
              {connectError}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="hc-title text-xl">Costs</h1>
      <p className="hc-thread-meta text-xs">
        Every paid API/service this app depends on. Dollar figures are ballpark,
        not a live billing pull - click through to each dashboard for real
        current spend. Private page, deliberately not in the public llms.txt.
      </p>

      <div className="flex flex-col gap-3">
        {ROWS.map((row) => (
          <div key={row.service} className="hc-box p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="hc-thread-subject text-sm">{row.service}</span>
              <a
                href={row.dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hc-link text-xs shrink-0"
              >
                dashboard ↗
              </a>
            </div>
            <dl className="mt-2 flex flex-col gap-1.5 text-xs">
              <div>
                <dt className="hc-thread-meta inline">Used for: </dt>
                <dd className="inline">{row.usedFor}</dd>
              </div>
              <div>
                <dt className="hc-thread-meta inline">Pricing: </dt>
                <dd className="inline">{row.pricingModel}</dd>
              </div>
              <div>
                <dt className="hc-thread-meta inline">Estimate: </dt>
                <dd className="inline">{row.estimate}</dd>
              </div>
              <div>
                <dt className="hc-thread-meta inline">Cost control: </dt>
                <dd className="inline">{row.costControl}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
