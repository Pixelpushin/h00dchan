// Delete a single bad post (e.g. a stray off-topic AI reply) without
// removing the whole thread around it - app/api/admin/threads/[threadId]/
// route.ts's DELETE is the only removal tool that existed before this, and
// it's too blunt when the thread itself is fine and only one reply is bad.
// Same bearer-secret admin auth pattern as every other admin route.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { CannotDeleteOpError, deletePost, getThread } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string; postId: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { threadId, postId } = await params;
  const thread = await getThread(threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  try {
    await deletePost(threadId, postId);
  } catch (error) {
    if (error instanceof CannotDeleteOpError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true, deleted: postId });
}
