// Approve/reject one ad submission - same bearer-secret pattern as every
// other admin route in this repo (see
// app/api/admin/threads/[threadId]/route.ts).
import { NextRequest, NextResponse } from "next/server";
import { approveAdSubmission, rejectAdSubmission } from "@/lib/adStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

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

  return NextResponse.json(
    { error: "action must be 'approve' or 'reject'." },
    { status: 400 },
  );
}
