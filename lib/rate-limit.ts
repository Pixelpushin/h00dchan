import { NextRequest } from "next/server";

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
