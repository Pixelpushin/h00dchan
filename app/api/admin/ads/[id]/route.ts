// Approve/reject one ad submission - same bearer-secret pattern as every
// other admin route in this repo (see
// app/api/admin/threads/[threadId]/route.ts).
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import {
  approveAdSubmission,
  rejectAdSubmission,
  resyncAdArt,
} from "@/lib/adStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { action, reason } = (payload ?? {}) as Record<string, unknown>;

  if (action === "approve") {
    const ad = await approveAdSubmission(id);
    if (!ad) {
      return NextResponse.json({ error: "Ad not found." }, { status: 404 });
    }
    return NextResponse.json({ ad });
  }

  if (action === "reject") {
    const ad = await rejectAdSubmission(
      id,
      typeof reason === "string" ? reason : undefined,
    );
    if (!ad) {
      return NextResponse.json({ error: "Ad not found." }, { status: 404 });
    }
    return NextResponse.json({ ad });
  }

  if (action === "resync") {
    const result = await resyncAdArt(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }
    return NextResponse.json({ ad: result.ad });
  }

  return NextResponse.json(
    { error: "action must be 'approve', 'reject', or 'resync'." },
    { status: 400 },
  );
}
