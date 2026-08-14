import { NextRequest, NextResponse } from "next/server";
import { deleteThread, getThread } from "@/lib/store";

// Minimal moderation endpoint - any live imageboard needs a way to remove a
// thread (bad AI generation, abuse, whatever), and there was no such path
// until now. Reuses H00DCHAN_CRON_SECRET as the admin bearer token rather
// than introducing a second secret - this is an MVP-scale admin action, not
// a multi-operator moderation system with its own auth tier.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { threadId } = await params;
  const thread = await getThread(threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  await deleteThread(threadId);
  return NextResponse.json({ ok: true, deleted: threadId });
}
