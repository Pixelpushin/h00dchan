import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import {
  listVerifiedTokenIds,
  markBioRevoked,
  touchBioLastChecked,
  getBioVerification,
} from "@/lib/bioVerifyStore";
import { fetchXUserBio } from "@/lib/xApi";

// Bi-weekly recheck: re-reads every currently-verified holder's bio, and
// revokes (drops the XP bonus) if the phrase is no longer there - same
// "resets when the thing goes away" pattern as the hodler-streak XP
// resetting on a sale.
//
// Self-paginating: the Vercel Cron trigger (see vercel.json) hits this
// with no ?start= at all, and this route loops internally across pages
// until either everything's done or it's eaten most of the 60s budget -
// no external re-triggering needed at realistic scale (a niche
// collection's opted-in holders, not thousands). Passing an explicit
// ?start=&count= (e.g. for manual/debug calls) processes just that one
// page instead - same shape the earlier image-CDN backfill uses, which
// hit a real serverless timeout the first time it tried to do too much in
// one request; this route is built with that safety margin from day one
// rather than relearning it live.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CONCURRENCY = 6;
const MAX_COUNT = 60;
const DEFAULT_COUNT = 40;
// Leaves ~10s margin under maxDuration for the internal-loop path to stop
// starting new pages and return whatever it's finished, rather than
// risking a mid-page kill with no response at all.
const WALL_CLOCK_BUDGET_MS = 50_000;

interface PageResult {
  stillVerified: number;
  revoked: number;
  errors: number;
}

async function runPage(ids: string[]): Promise<PageResult> {
  const result: PageResult = { stillVerified: 0, revoked: 0, errors: 0 };

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (tokenId): Promise<keyof PageResult> => {
        const record = await getBioVerification(tokenId);
        if (!record || record.status !== "verified") {
          return "stillVerified"; // already handled elsewhere (e.g. mid-run revoke), skip
        }
        try {
          const bio = await fetchXUserBio(record.xHandle);
          // checkText, not phrase - see app/api/bio-verify/check/route.ts's
          // comment (X auto-linkifies the site tag, so the full phrase
          // never survives verbatim in a real saved bio).
          const stillThere =
            bio !== null &&
            bio.description
              .toLowerCase()
              .includes(record.checkText.toLowerCase());
          if (stillThere) {
            await touchBioLastChecked(tokenId);
            return "stillVerified";
          }
          await markBioRevoked(tokenId);
          return "revoked";
        } catch {
          // X API hiccup - leave the record as-is rather than revoke on a
          // transient failure; the next run picks it up naturally since
          // it's still in the verified index.
          return "errors";
        }
      }),
    );
    for (const key of batchResults) result[key] += 1;
  }

  return result;
}

async function handle(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const params = request.nextUrl.searchParams;
  const hasExplicitStart = params.has("start");
  const count = Math.min(
    MAX_COUNT,
    Math.max(1, Number(params.get("count")) || DEFAULT_COUNT),
  );

  const allIds = await listVerifiedTokenIds();
  const totals: PageResult = { stillVerified: 0, revoked: 0, errors: 0 };

  if (hasExplicitStart) {
    const start = Math.max(0, Number(params.get("start")) || 0);
    const page = allIds.slice(start, start + count);
    const result = await runPage(page);
    return NextResponse.json({
      mode: "single-page",
      totalVerified: allIds.length,
      range: { start, end: start + page.length },
      ...result,
      nextStart:
        start + page.length < allIds.length ? start + page.length : null,
    });
  }

  // Cron path: loop through everything, bailing out on wall-clock budget
  // rather than array exhaustion - safe even if the verified-holder count
  // grows past what fits in one run (the next scheduled trigger picks up
  // wherever this one left off, since already-checked-this-run tokens
  // were just touched, not removed from the index).
  const startedAt = Date.now();
  let start = 0;
  let ranOutOfTime = false;
  while (start < allIds.length) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
      ranOutOfTime = true;
      break;
    }
    const page = allIds.slice(start, start + count);
    const result = await runPage(page);
    totals.stillVerified += result.stillVerified;
    totals.revoked += result.revoked;
    totals.errors += result.errors;
    start += page.length;
  }

  return NextResponse.json({
    mode: "full-sweep",
    totalVerified: allIds.length,
    processed: start,
    ranOutOfTime,
    ...totals,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
