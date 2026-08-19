// Same scoring algorithm as scripts/compute-rarity.ts, but reads whatever
// token metadata is ALREADY cached in Redis (getCachedTokenMetadata - a
// plain GET, no IPFS call) instead of re-fetching all 1200 tokens fresh.
// The standalone script needs real local access to this app's production
// KV credentials to run against the real store - `vercel env pull`
// redacts sensitive/integration-managed env vars (including these) to
// empty strings, so there's no way to extract them locally; this endpoint
// runs the computation server-side instead, where the real credentials
// are already injected by the platform, and stays fast enough for one
// serverless invocation precisely because it skips IPFS entirely. Most
// tokens are already cached anyway just from ordinary site traffic
// (board/leaderboard/wallet pages all resolve through
// getOrFetchTokenMetadata, which caches on every miss) - this only
// produces an incomplete index if run before the collection has ever
// really been browsed, in which case re-running it later (as more tokens
// get organically cached) only improves it.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import {
  getCachedTokenMetadata,
  writeRarityIndex,
  type RarityIndex,
} from "@/lib/store";
import type { TokenMetadata } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TOTAL_SUPPLY = 1200;

function buildFrequencyTable(
  metadataById: Map<number, TokenMetadata>,
): Map<string, number> {
  const freq = new Map<string, number>();
  for (const meta of metadataById.values()) {
    for (const attr of meta.attributes) {
      if (!attr.trait_type || attr.value === undefined) continue;
      const key = `${attr.trait_type}::${attr.value}`;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  return freq;
}

function scoreToken(
  meta: TokenMetadata,
  freq: Map<string, number>,
  totalTokens: number,
): number {
  let score = 0;
  for (const attr of meta.attributes) {
    if (!attr.trait_type || attr.value === undefined) continue;
    const key = `${attr.trait_type}::${attr.value}`;
    const count = freq.get(key) ?? totalTokens;
    score += totalTokens / count;
  }
  return score;
}

async function handle(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const ids = Array.from({ length: TOTAL_SUPPLY }, (_, i) => i + 1);
  const metadataById = new Map<number, TokenMetadata>();
  // Redis reads only - cheap enough to do all 1200 without chunking,
  // unlike the IPFS-backed script this mirrors.
  const CONCURRENCY = 50;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((id) => getCachedTokenMetadata(String(id)).catch(() => null)),
    );
    batch.forEach((id, j) => {
      const meta = results[j];
      if (meta) metadataById.set(id, meta);
    });
  }

  const succeeded = metadataById.size;
  if (succeeded === 0) {
    return NextResponse.json(
      { error: "No cached metadata found for any token - nothing to score." },
      { status: 409 },
    );
  }

  const freq = buildFrequencyTable(metadataById);
  const scored = [...metadataById.entries()].map(([tokenId, meta]) => ({
    tokenId,
    score: scoreToken(meta, freq, succeeded),
  }));
  scored.sort((a, b) => b.score - a.score);

  const entries: RarityIndex["entries"] = {};
  scored.forEach((entry, i) => {
    entries[String(entry.tokenId)] = { score: entry.score, rank: i + 1 };
  });

  const index: RarityIndex = {
    computedAt: new Date().toISOString(),
    totalSupply: succeeded,
    entries,
  };
  await writeRarityIndex(index);

  return NextResponse.json({
    ok: true,
    tokensScored: succeeded,
    tokensMissingFromCache: TOTAL_SUPPLY - succeeded,
    top10: scored.slice(0, 10).map((e) => ({
      tokenId: e.tokenId,
      rank: entries[String(e.tokenId)].rank,
      score: e.score,
    })),
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
