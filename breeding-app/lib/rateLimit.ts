// Local fork of the parent h00dchan app's lib/rate-limit.ts
// (checkExpensiveScanRateLimit + getClientIp pattern), trimmed to the one
// budget this app actually needs. NOT imported from the parent app on
// purpose - breeding-app ships as its own separate Vercel project and
// deliberately never cross-imports the parent (see this app's lib/*.ts
// header convention). Same in-memory sliding-window Map approach, same
// known limitation: resets on cold-start/redeploy and doesn't coordinate
// across multiple serverless instances - a platform/CDN-level limiter is
// the real production answer, but this is the right scope for this
// codebase today (first layer, not the only layer).
//
// Used by any route that does a live, non-trivial amount of RPC/upstream
// work reachable with nothing more than a syntactically valid param in the
// URL - `checkExpensiveScanRateLimit`'s bucket is shared by any
// family-tree/lineage route that does a full eth_getLogs scan of every Bred
// event ever emitted; app/api/breed/[txHash]/route.ts (receipt fetch + full
// Bred-event decode + an OpenAI image generation + a Blob write on a cache
// miss) has its OWN dedicated `checkBreedPollRateLimit` bucket below (see
// that function's own comment for why sharing the scan bucket was a
// self-DoS bug).

interface RateEntry {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 5 * 60 * 1000;

function prune(store: Map<string, RateEntry>, now: number) {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

function consume(
  store: Map<string, RateEntry>,
  key: string,
  max: number,
  now: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

// Minimal structural type covering BOTH a route handler's
// `NextRequest.headers` AND a server component's `headers()` (from
// `next/headers`, a `ReadonlyHeaders`) - the family-tree page needs the
// same rate limit as a route handler but is a server component, not a
// route handler, so it has no `NextRequest` to pass in. Both real types
// satisfy this shape.
export interface HeaderSource {
  get(name: string): string | null;
}

// Same reasoning/known-limitation as the parent app's getClientIp: Vercel's
// edge network always sets x-forwarded-for, so the shared-"unknown"-bucket
// fallback only matters off that deployment target.
export function getClientIp(headers: HeaderSource): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  scope: "ip";
}

// IP-only (no wallet signature involved in any route that uses this): a
// generous-but-real cap on expensive-scan/generation routes, sized the same
// way as the parent app's own EXPENSIVE_SCAN_IP_MAX - tight enough to blunt
// scripted flooding of an OpenAI-image-generation or full-event-log-scan
// route, generous enough that a real user polling
// app/api/breed/[txHash]/route.ts (every 3s, up to 60 attempts, per this
// app's own pollForResult) never trips it during one real breed.
const expensiveScanIpLimit = new Map<string, RateEntry>();
const EXPENSIVE_SCAN_IP_MAX = 60;

export function checkExpensiveScanRateLimit(
  headers: HeaderSource,
): RateLimitResult {
  const now = Date.now();
  prune(expensiveScanIpLimit, now);
  const result = consume(
    expensiveScanIpLimit,
    getClientIp(headers),
    EXPENSIVE_SCAN_IP_MAX,
    now,
  );
  return { ...result, scope: "ip" };
}

// ITEM 9 fix: app/api/breed/[txHash]/route.ts's own poll loop
// (app/breed/[collection]/[tokenId]/page.tsx's pollForResult - up to 60
// attempts, 3s apart, i.e. sized 1:1 against exactly ONE poll run) was
// sharing `expensiveScanIpLimit` with the family-tree/scan routes above.
// Since that bucket's max (60) is sized for exactly one poll run with zero
// headroom, a single breed polling to completion could fully exhaust the
// shared budget for the rest of that 5-minute window - starving every other
// expensive-scan route (and any concurrent second breed) on the same IP.
// Dedicated bucket, same Map<string, RateEntry> + prune()/consume() pattern
// as above, sized for at least 2 concurrent poll runs (2 * 60 = 120) plus
// slack for the occasional extra poll/retry a slow network causes.
const breedPollIpLimit = new Map<string, RateEntry>();
const BREED_POLL_IP_MAX = 150;

export function checkBreedPollRateLimit(
  headers: HeaderSource,
): RateLimitResult {
  const now = Date.now();
  prune(breedPollIpLimit, now);
  const result = consume(
    breedPollIpLimit,
    getClientIp(headers),
    BREED_POLL_IP_MAX,
    now,
  );
  return { ...result, scope: "ip" };
}
