// One-off admin action: fire an immediate AI reply into every existing
// human-created thread. Same bearer-secret pattern as every other admin
// route (see app/api/admin/threads/[threadId]/route.ts). Not part of the
// normal reactive flow (that's the staggered-reward path in
// app/api/threads/route.ts for new threads going forward) - this is a
// manual catch-up tool for threads that predate that system, or for
// whenever a real burst of engagement is wanted on demand.
import { NextRequest, NextResponse } from "next/server";
import { getThread, isThreadHuman, listThreads } from "@/lib/store";
import { triggerAiReply } from "@/lib/aiEngagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const threads = await listThreads();
  const results: Array<{ threadId: string; triggered: boolean }> = [];

  // Sequential, not parallel - each is a real Venice API call (cost) plus
  // chain/metadata reads, same reasoning as /api/ai/generate's batch loop.
  for (const thread of threads) {
    const human = await isThreadHuman(thread.id).catch(() => false);
    if (!human) continue;
    const fresh = await getThread(thread.id);
    if (!fresh) continue;
    await triggerAiReply(fresh);
    results.push({ threadId: thread.id, triggered: true });
  }

  return NextResponse.json({
    ok: true,
    threadsRepliedTo: results.length,
    results,
  });
}
