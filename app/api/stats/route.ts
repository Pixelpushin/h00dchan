import { NextResponse } from "next/server";
import { getClaimStats } from "@/lib/store";

// Public, unauthenticated - just a claimed/total count for the progress bar
// on the connect page. Cheap (one SCARD) and safe to expose.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await getClaimStats();
  return NextResponse.json(stats, {
    headers: { "Cache-Control": "public, max-age=30" },
  });
}
