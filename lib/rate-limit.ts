import { NextRequest } from "next/server";

// TODO(rate-limit): this whole module is in-memory (Map-based), so budgets
// reset on every deploy/cold-start and don't coordinate across multiple
// serverless instances - a determined attacker spread across instances gets
// a fresh budget per instance. The real fix is a Redis-backed fixed-window
// counter via lib/store.ts's redisCommand (INCR the key, EXPIRE it only on
// the first increment of the window) instead of the local Maps below. That
// is NOT done here because it would force checkWriteRateLimit,
// checkSignalsRateLimit, and checkPublicApiRateLimit to become async (a
// Redis round trip can't stay synchronous), which breaks every existing
// call site - none of them currently `await` these calls. As of this
// writing that's 15 call sites across 15 route files that would all need a
// same-PR `await` added:
//   checkWriteRateLimit      - app/api/bio-verify/start/route.ts
//                             - app/api/alpha/research/route.ts
//                             - app/api/claim/route.ts
//                             - app/api/claim/batch/route.ts
//                             - app/api/threads/route.ts
//                             - app/api/threads/[threadId]/posts/route.ts
//   checkSignalsRateLimit    - app/api/ads/route.ts
//                             - app/api/bio-verify/check/route.ts
//                             - app/api/signals/route.ts
//                             - app/api/onlychans/is-holder/route.ts
//   checkPublicApiRateLimit  - app/api/v1/leaderboard/route.ts
//                             - app/api/v1/token/[tokenId]/route.ts
//                             - app/api/v1/collection/route.ts
//                             - app/api/v1/tokens/route.ts
//                             - app/api/v1/wallet/[address]/route.ts
// Until someone does that whole sweep in one PR, keep every exported check
// here synchronous with today's signatures - a half-migrated
// sync/async split is worse than the current single-instance limitation.

// In-memory sliding-window rate limiting, ported from the same pattern the
// sibling hoodies/app/api/hood-talk route uses. This exists because
// verifyPersonaClaim's signature check is cheap local crypto, but confirming
// it forces a live eth_call to a public RPC - and signing a claim costs an
// attacker nothing (any throwaway keypair can produce a syntactically valid
// signature; it just won't own the token). Without a cap in front of that,
// a non-holder can fire unlimited requests and force unlimited RPC calls,
// risking the app's own RPC access getting throttled/banned for everyone,
// holders included. This is a first layer (in-process, so it resets on
// deploy and doesn't coordinate across multiple instances) - a platform/CDN
// level limiter is the real production answer, but this is the right scope
// for this codebase today, matching hood-talk's existing precedent.
//
// Three independent limits, checked in cheapest-first order by the caller:
// per-IP (blunts raw request-volume floods regardless of whether a valid
// signature is attached), per-address, and per-token (both keyed on values
// only available after basic shape validation, so junk input never reaches
// them).

interface RateEntry {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 5 * 60 * 1000;

const ipLimit = new Map<string, RateEntry>();
const addressLimit = new Map<string, RateEntry>();
const tokenLimit = new Map<string, RateEntry>();

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

export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  scope?: "ip" | "address" | "token";
}

// Generous enough for organic conversation (a real thread can have someone
// replying many times), tight enough to blunt scripted flooding from a
// single source. address/token limits are stricter than the IP limit since
// they're the more targeted resource (one signer, one token) - a shared IP
// (NAT, VPN) legitimately needs more headroom than a single wallet does.
const IP_MAX = 20;
const ADDRESS_MAX = 15;
const TOKEN_MAX = 10;

export function checkWriteRateLimit(
  request: NextRequest,
  address: string,
  tokenId: string,
): RateLimitResult {
  const now = Date.now();
  prune(ipLimit, now);
  prune(addressLimit, now);
  prune(tokenLimit, now);

  const ip = consume(ipLimit, getClientIp(request), IP_MAX, now);
  if (!ip.allowed) return { ...ip, scope: "ip" };

  const byAddress = consume(
    addressLimit,
    address.toLowerCase(),
    ADDRESS_MAX,
    now,
  );
  if (!byAddress.allowed) return { ...byAddress, scope: "address" };

  const byToken = consume(tokenLimit, tokenId, TOKEN_MAX, now);
  if (!byToken.allowed) return { ...byToken, scope: "token" };

  return { allowed: true, retryAfterSeconds: 0 };
}

// Dual-layer pair for routes that want the address/token budget to only be
// spendable by someone who has actually proven ownership (see
// app/api/threads/route.ts and app/api/threads/[threadId]/posts/route.ts).
// checkWriteRateLimit above still keys address/token budget on whatever the
// request body claims BEFORE verifyPersonaClaim runs, which is exactly the
// gap this pair closes: a client sends any address it likes, no signature
// required to spend that address's budget. Splitting it means:
//   1. checkWriteIpRateLimit runs first, pre-verify, cheap-rejection - it's
//      IP-only (not spoofable via request body) so it's safe to consume
//      before proving anything, same as checkWriteRateLimit's IP layer.
//      Shares the same ipLimit map/budget as checkWriteRateLimit so the IP
//      dimension stays one consistent budget across every write route.
//   2. consumeVerifiedWriteBudget runs ONLY after verifyPersonaClaim
//      returns ok:true, keyed on the address/tokenId that verification just
//      confirmed the caller actually controls (signature recovery matched
//      `address`, and a live ownership check confirmed `address` currently
//      owns `tokenId`) - so an attacker spamming a victim's public address
//      with no valid signature never reaches this call, and only ever
//      burns their own IP budget from step 1. Shares the same
//      addressLimit/tokenLimit maps as checkWriteRateLimit so a token/
//      address that's already near its budget via one of the routes still
//      using the pre-verify combined check (bio-verify/start, alpha/
//      research, claim, claim/batch) doesn't get a second, independent
//      budget here.
export function checkWriteIpRateLimit(request: NextRequest): RateLimitResult {
  const now = Date.now();
  prune(ipLimit, now);
  const result = consume(ipLimit, getClientIp(request), IP_MAX, now);
  return { ...result, scope: "ip" };
}

export function consumeVerifiedWriteBudget(
  address: string,
  tokenId: string,
): RateLimitResult {
  const now = Date.now();
  prune(addressLimit, now);
  prune(tokenLimit, now);

  const byAddress = consume(
    addressLimit,
    address.toLowerCase(),
    ADDRESS_MAX,
    now,
  );
  if (!byAddress.allowed) return { ...byAddress, scope: "address" };

  const byToken = consume(tokenLimit, tokenId, TOKEN_MAX, now);
  if (!byToken.allowed) return { ...byToken, scope: "token" };

  return { allowed: true, retryAfterSeconds: 0 };
}

// A separate map from the write-path limits above: /api/signals is public
// and unauthenticated (no address/token to key on, no signature to verify),
// so per-IP is the only dimension available - and it shouldn't share a
// budget with the write endpoints, since a burst of legitimate reads
// shouldn't eat into someone's ability to post.
const signalsIpLimit = new Map<string, RateEntry>();
const SIGNALS_IP_MAX = 30;

export function checkSignalsRateLimit(request: NextRequest): RateLimitResult {
  const now = Date.now();
  prune(signalsIpLimit, now);
  const result = consume(
    signalsIpLimit,
    getClientIp(request),
    SIGNALS_IP_MAX,
    now,
  );
  return { ...result, scope: "ip" };
}

// Own budget, separate from every limit above - the public dev API
// (app/api/v1/**) is meant to be genuinely useful for a real integration
// polling on a schedule, not just occasional page-load traffic like
// /api/signals, so the ceiling is higher. Still IP-only: no wallet
// signature involved, so address/token dimensions don't apply here.
const publicApiIpLimit = new Map<string, RateEntry>();
const PUBLIC_API_IP_MAX = 120;

export function checkPublicApiRateLimit(request: NextRequest): RateLimitResult {
  const now = Date.now();
  prune(publicApiIpLimit, now);
  const result = consume(
    publicApiIpLimit,
    getClientIp(request),
    PUBLIC_API_IP_MAX,
    now,
  );
  return { ...result, scope: "ip" };
}
