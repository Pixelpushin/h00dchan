// Cron-triggered daily digest generation - see vercel.json for the
// schedule. Same bearer-secret admin pattern as every other cron/admin
// route in this app (H00DCHAN_CRON_SECRET).
import { NextRequest, NextResponse } from "next/server";
import { generateDailyAlphaDigest } from "@/lib/dailyAlpha";
import { setDailyAlphaDigest } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const digest = await generateDailyAlphaDigest();
    await setDailyAlphaDigest(digest);
    return NextResponse.json({ ok: true, digest });
  } catch (error) {
    console.error("Failed to generate daily alpha digest", error);
    return NextResponse.json(
      { error: "Failed to generate digest." },
      { status: 500 },
    );
  }
}

// Vercel Cron always fires GET; POST is kept for manual/admin triggering
// (same dual-handler shape as app/api/ai/process-scheduled/route.ts).
export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
