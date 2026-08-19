import { NextRequest } from "next/server";
import { getOrFetchTokenMetadata } from "@/lib/store";
import { checkPublicApiRateLimit } from "@/lib/rate-limit";
import {
  jsonWithCors,
  rateLimitResponse,
  corsPreflightResponse,
} from "@/lib/publicApi";

// Public dev API - lightweight paginated list (tokenId/name/image only,
// no wallet/level data - use /api/v1/token/{tokenId} for the full record
// of one anon) for building a gallery/grid without 1198 separate requests.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOKEN_ID = 1200;
const MAX_COUNT = 100;
const DEFAULT_COUNT = 50;
const CONCURRENCY = 10;

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(request: NextRequest) {
  const limit = checkPublicApiRateLimit(request);
  if (!limit.allowed) return rateLimitResponse(limit);

  const params = request.nextUrl.searchParams;
  const start = Math.max(1, Number(params.get("start")) || 1);
  const count = Math.min(
    MAX_COUNT,
    Math.max(1, Number(params.get("count")) || DEFAULT_COUNT),
  );
  const end = Math.min(MAX_TOKEN_ID, start + count - 1);
  if (start > MAX_TOKEN_ID) {
    return jsonWithCors(
      { error: "start beyond max token ID (1200)." },
      { status: 400 },
    );
  }

  const ids = Array.from({ length: end - start + 1 }, (_, i) =>
    String(start + i),
  );
  const tokens: Array<{ tokenId: string; name: string; image: string }> = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (tokenId) => {
        try {
          const metadata = await getOrFetchTokenMetadata(tokenId);
          return { tokenId, name: metadata.name, image: metadata.image };
        } catch {
          return null; // burned/never-minted/unresolvable - silently skipped, not an error for a list endpoint
        }
      }),
    );
    for (const r of results) if (r) tokens.push(r);
  }

  return jsonWithCors({
    range: { start, end },
    count: tokens.length,
    nextStart: end < MAX_TOKEN_ID ? end + 1 : null,
    tokens,
  });
}
