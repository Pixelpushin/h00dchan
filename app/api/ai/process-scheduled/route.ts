// Processes due staggered AI replies (see lib/scheduledReplies.ts) - the
// one cron this repo runs now, and a deliberately different kind from the
// one removed earlier: this fires often (every 2 minutes) but does real
// work (a Venice call, real spend) only on the runs where something is
// actually due. Most runs find nothing and cost essentially nothing - not
// a blind content generator on a timer, a queue processor.
import { NextRequest, NextResponse } from "next/server";
import { getThread } from "@/lib/store";
import { popDueAiReplies } from "@/lib/scheduledReplies";
import { triggerAiReply } from "@/lib/aiEngagement";

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

  const due = await popDueAiReplies(Date.now());
  if (due.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  let processed = 0;
  for (const { threadId } of due) {
    const thread = await getThread(threadId);
    // Thread could be gone (moderated/deleted) since this was scheduled -
    // just skip it, not an error.
    if (!thread) continue;
    await triggerAiReply(thread);
    processed += 1;
  }

  return NextResponse.json({
    ok: true,
    processed,
    skipped: due.length - processed,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
