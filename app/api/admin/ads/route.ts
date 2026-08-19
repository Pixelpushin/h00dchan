// Admin-only list of ads awaiting manual review - same lib/adminAuth.ts
// requireAdmin gate as every other admin route in this repo.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { listPendingAdSubmissions } from "@/lib/adStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const pending = await listPendingAdSubmissions();
  return NextResponse.json({ pending });
}
