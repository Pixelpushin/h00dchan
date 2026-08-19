import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { getCachedTokenMetadata, getOrFetchTokenMetadata } from "@/lib/store";

// One-time (well, re-runnable) backfill: resolves and permanently caches
// every token's metadata, so live user traffic never depends on a public
// IPFS gateway responding in real time again. Built after verifying live
// that even a bounded parallel gateway race (see lib/chain.ts's
// fetchIpfsJson) can't help when gateways are genuinely failing outright,
// not just slow - racing only bounds latency, it can't fix unavailability.
// Once every token is cached, that stops mattering: cache hits never touch
// IPFS at all.
//
// Runs inside Vercel where the real KV_REST_API_URL/TOKEN exist (they're
// marked Sensitive, so `vercel env pull` can't retrieve them locally -
// this route is the only way to drive a bulk write against them).
// Ranged via ?start=&count= so one request stays well under any serverless
// function timeout; call it repeatedly to cover all 1200 tokens.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOKEN_ID = 1200;
const CONCURRENCY = 8;
const DEFAULT_COUNT = 100;

async function handle(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const params = request.nextUrl.searchParams;
  const start = Math.max(1, Number(params.get("start")) || 1);
  const count = Math.min(
    300,
    Math.max(1, Number(params.get("count")) || DEFAULT_COUNT),
  );
  const skipCached = params.get("skipCached") !== "false";
  const end = Math.min(MAX_TOKEN_ID, start + count - 1);

  const ids = Array.from({ length: end - start + 1 }, (_, i) =>
    String(start + i),
  );

  const results: Array<{
    tokenId: string;
    status: "cached" | "resolved" | "failed";
    error?: string;
  }> = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (tokenId) => {
        if (skipCached) {
          const already = await getCachedTokenMetadata(tokenId).catch(
            () => null,
          );
          if (already) return { tokenId, status: "cached" as const };
        }
        try {
          await getOrFetchTokenMetadata(tokenId);
          return { tokenId, status: "resolved" as const };
        } catch (err) {
          return {
            tokenId,
            status: "failed" as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const summary = {
    range: { start, end },
    cached: results.filter((r) => r.status === "cached").length,
    resolved: results.filter((r) => r.status === "resolved").length,
    failed: results.filter((r) => r.status === "failed").length,
    failedIds: results
      .filter((r) => r.status === "failed")
      .map((r) => r.tokenId),
    nextStart: end < MAX_TOKEN_ID ? end + 1 : null,
  };

  return NextResponse.json(summary);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
