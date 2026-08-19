// One-off admin action: fire an immediate AI reply into every existing
// human-created thread. Same bearer-secret pattern as every other admin
// route (see app/api/admin/threads/[threadId]/route.ts). Not part of the
// normal reactive flow (that's the staggered-reward path in
// app/api/threads/route.ts for new threads going forward) - this is a
// manual catch-up tool for threads that predate that system, or for
// whenever a real burst of engagement is wanted on demand.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { getThread, isThreadHuman, listThreads } from "@/lib/store";
import { triggerAiReply } from "@/lib/aiEngagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

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
