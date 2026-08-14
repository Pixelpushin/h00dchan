// Admin-only list of ads awaiting manual review - same bearer-secret
// pattern as every other admin route in this repo (see
// app/api/admin/threads/[threadId]/route.ts).
import { NextRequest, NextResponse } from "next/server";
import { listPendingAdSubmissions } from "@/lib/adStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkAuth(request: NextRequest): boolean {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const pending = await listPendingAdSubmissions();
  return NextResponse.json({ pending });
}
