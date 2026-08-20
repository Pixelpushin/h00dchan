// Remove a garbage/spam registry entry - same bearer-secret-or-wallet-
// signature admin pattern as every other app/api/admin/** route (see
// lib/adminAuth.ts). No approve action needed here (unlike ads): the
// eligibility bar itself is the gate, entries go live immediately on
// submission - this route only exists for after-the-fact moderation.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { removeRegistryEntry } from "@/lib/registryStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const removed = await removeRegistryEntry(id);
  if (!removed) {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
