import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { addAdminNote, listAdminNotes } from "@/lib/adminNotesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NOTE_LENGTH = 2000;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const notes = await listAdminNotes();
  return NextResponse.json({ notes });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_NOTE_LENGTH) {
    return NextResponse.json({ error: "Invalid note text." }, { status: 400 });
  }

  const address = request.headers.get("x-admin-address") ?? "cron";
  const note = await addAdminNote(text, address);
  return NextResponse.json({ note });
}
