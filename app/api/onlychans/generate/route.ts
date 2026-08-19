// Cron-triggered (and admin-triggerable) generation of one onlyChans post.
// Same dual-credential gate as every other admin/cron route in this app -
// requireAdmin accepts either H00DCHAN_CRON_SECRET (what Vercel Cron sends
// as CRON_SECRET, kept equal in production - see vercel.json) or an admin
// wallet signature. Nothing here is reachable by a holder or the public;
// holders can only ever READ the feed (see ../feed/route.ts), never
// trigger generation - keeps OpenAI spend bounded to the cron schedule.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { randomCaption, randomPrompt } from "@/lib/onlychansConfig";
import { generateOnlyChanImage } from "@/lib/onlychansImage";
import { createOnlyChanPost } from "@/lib/onlychansStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const prompt = randomPrompt();
  try {
    const { blobUrl } = await generateOnlyChanImage(prompt);
    const post = await createOnlyChanPost({
      imageUrl: blobUrl,
      prompt,
      caption: randomCaption(),
    });
    return NextResponse.json({ ok: true, post });
  } catch (error) {
    console.error("onlyChans generate failed", error);
    return NextResponse.json(
      { error: "Failed to generate post." },
      { status: 500 },
    );
  }
}

// Vercel Cron always fires GET; POST is kept for manual/admin triggering.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
