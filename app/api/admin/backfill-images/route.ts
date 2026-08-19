import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { requireAdmin } from "@/lib/adminAuth";
import { getOrFetchTokenMetadata, cacheTokenMetadata } from "@/lib/store";

// One-time (re-runnable) backfill: copies every token's image from a live
// IPFS gateway to Vercel Blob storage, then rewrites the cached
// TokenMetadata.image field to point at the Blob URL permanently. Same
// motivation and shape as backfill-metadata/route.ts (immutable art, cache
// once, never depend on a flaky gateway again on the hot path) - this is
// the image half of that same fix, since backfill-metadata only ever
// cached the JSON (name/attributes/the image *URL string*), never the
// image bytes themselves. Blob URLs are served straight off Vercel's CDN,
// so once backfilled an image request never touches this app's server,
// Redis, or IPFS at all.
//
// Idempotent: a token whose cached metadata.image already points at this
// project's own Blob store (checked via BLOB_HOSTNAME_MARKER, not by
// re-fetching Blob's own file list) is skipped by default - same
// ?skipCached= pattern as backfill-metadata, default true.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel's serverless function ceiling on this project (confirmed live:
// a count=100 request hit exactly this and returned nothing, HTTP 000) -
// unlike backfill-metadata's lightweight JSON-only fetches, each token
// here does a real image download plus a Blob upload, so the safe count
// per request is much lower (see the lowered MAX_COUNT/DEFAULT_COUNT
// below) rather than trying to push past this ceiling.
export const maxDuration = 60;

const MAX_TOKEN_ID = 1200;
const CONCURRENCY = 6;
const MAX_COUNT = 40;
const DEFAULT_COUNT = 25;
const FETCH_TIMEOUT_MS = 15_000;

// Vercel Blob public URLs are always on this domain - cheap way to detect
// "already backfilled" without a second API call per token.
const BLOB_HOSTNAME_MARKER = ".public.blob.vercel-storage.com/";

function guessContentType(url: string, fallback: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return fallback;
}

async function handle(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const params = request.nextUrl.searchParams;
  const start = Math.max(1, Number(params.get("start")) || 1);
  const count = Math.min(
    MAX_COUNT,
    Math.max(1, Number(params.get("count")) || DEFAULT_COUNT),
  );
  const skipCached = params.get("skipCached") !== "false";
  const end = Math.min(MAX_TOKEN_ID, start + count - 1);

  const ids = Array.from({ length: end - start + 1 }, (_, i) =>
    String(start + i),
  );

  const results: Array<{
    tokenId: string;
    status: "skipped" | "backfilled" | "no-metadata" | "failed";
    error?: string;
  }> = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (tokenId) => {
        let metadata;
        try {
          metadata = await getOrFetchTokenMetadata(tokenId);
        } catch (err) {
          return {
            tokenId,
            status: "no-metadata" as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        if (skipCached && metadata.image.includes(BLOB_HOSTNAME_MARKER)) {
          return { tokenId, status: "skipped" as const };
        }
        if (!metadata.image) {
          return { tokenId, status: "no-metadata" as const };
        }

        try {
          const res = await fetch(metadata.image, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
          const contentType = guessContentType(
            metadata.image,
            res.headers.get("content-type") ?? "image/png",
          );
          const extension = contentType.split("/")[1]?.split("+")[0] ?? "png";
          const bytes = await res.arrayBuffer();

          const blob = await put(
            `hoodchan/token-${tokenId}.${extension}`,
            bytes,
            {
              access: "public",
              contentType,
              addRandomSuffix: false,
              allowOverwrite: true,
            },
          );

          await cacheTokenMetadata(tokenId, {
            ...metadata,
            image: blob.url,
          });

          return { tokenId, status: "backfilled" as const };
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
    skipped: results.filter((r) => r.status === "skipped").length,
    backfilled: results.filter((r) => r.status === "backfilled").length,
    noMetadata: results.filter((r) => r.status === "no-metadata").length,
    failed: results.filter((r) => r.status === "failed").length,
    failedIds: results
      .filter((r) => r.status === "failed")
      .map((r) => ({ tokenId: r.tokenId, error: r.error })),
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
