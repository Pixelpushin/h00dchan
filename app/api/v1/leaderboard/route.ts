import { NextRequest } from "next/server";
import { computeLeaderboard } from "@/lib/leaderboard";
import { checkPublicApiRateLimit } from "@/lib/rate-limit";
import {
  jsonWithCors,
  rateLimitResponse,
  corsPreflightResponse,
} from "@/lib/publicApi";

// Public dev API - wraps lib/leaderboard.ts's own 60-second cache, so this
// never triggers a fresh chain scan per request. Same disclosed
// limitation as the /leaderboard page itself: only tokens that have ever
// claimed or posted are candidates (see lib/leaderboard.ts's header
// comment) - a wallet-only holder with zero site activity won't appear.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(request: NextRequest) {
  const limit = checkPublicApiRateLimit(request);
  if (!limit.allowed) return rateLimitResponse(limit);

  const params = request.nextUrl.searchParams;
  const count = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(params.get("limit")) || DEFAULT_LIMIT),
  );

  const entries = await computeLeaderboard();

  return jsonWithCors({
    total: entries.length,
    entries: entries.slice(0, count),
  });
}
