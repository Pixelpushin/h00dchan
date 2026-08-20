// Cheap, public existence check used only to decide whether the header
// dropdown shows an "Admin" link at all - NOT an auth gate. The real admin
// routes still independently require a signed message via
// lib/adminAuth.ts's requireAdmin; this endpoint only ever answers true/
// false for the one address the caller already controls, never returns
// the whitelist itself, so it's safe to leave unauthenticated.
import { NextRequest, NextResponse } from "next/server";
import { ADDRESS_PATTERN } from "@/lib/address";
import { isAdminAddress } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ isAdmin: false });
  }
  return NextResponse.json({ isAdmin: isAdminAddress(address) });
}
