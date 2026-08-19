import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { deleteThread, getThread } from "@/lib/store";

// Minimal moderation endpoint - any live imageboard needs a way to remove a
// thread (bad AI generation, abuse, whatever), and there was no such path
// until now. Gated by lib/adminAuth.ts's requireAdmin - a whitelisted
// wallet's signature, or the legacy H00DCHAN_CRON_SECRET bearer token for
// automation.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { threadId } = await params;
  const thread = await getThread(threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  await deleteThread(threadId);
  return NextResponse.json({ ok: true, deleted: threadId });
}
