// Shared helpers for the public developer API (app/api/v1/**) - CORS
// (this surface is meant to be called from a third-party site's own
// browser JS, unlike every other route in this app which is either
// same-origin or server-to-server and has never needed it) and a
// consistent rate-limit response shape, so every v1 route looks and
// behaves the same rather than five slightly different hand-rolled
// versions.
import { NextResponse } from "next/server";
import type { RateLimitResult } from "@/lib/rate-limit";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function jsonWithCors(
  data: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse {
  return NextResponse.json(data, {
    status: init?.status,
    headers: { ...CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function rateLimitResponse(result: RateLimitResult): NextResponse {
  return jsonWithCors(
    { error: "Too many requests. Slow down." },
    {
      status: 429,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    },
  );
}

// Every v1 route exports this verbatim as its OPTIONS handler - browsers
// preflight any cross-origin request with custom logic behind it, and
// without a 204 + the same CORS headers here, the actual GET never fires
// from a third-party site's JS at all.
export function corsPreflightResponse(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
