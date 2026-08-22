import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { addBridgedTrollboxMessage } from "@/lib/trollboxStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Relays already-anonymized messages into the trollbox from an external
// source (currently: a public X group chat, screenshotted and rewritten
// by a vision model into anon imageboard voice - see project notes, this
// route intentionally only accepts already-anonymized text, it doesn't
// do any screenshotting/vision-calling itself). requireAdmin (not the
// public persona-signed POST /api/trollbox) since there's no claimed
// anon to sign as - accepts either a real admin wallet signature or the
// H00DCHAN_CRON_SECRET bearer token, so this can be called by a future
// scheduled job with no human present, same as every other cron-style
// admin route in this app.
const MAX_BODY_LEN = 280;
const MAX_MESSAGES_PER_CALL = 20;

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { error: "Expected a non-empty `messages` array of strings." },
      { status: 400 },
    );
  }
  if (messages.length > MAX_MESSAGES_PER_CALL) {
    return NextResponse.json(
      { error: `At most ${MAX_MESSAGES_PER_CALL} messages per call.` },
      { status: 400 },
    );
  }
  const invalid = messages.some(
    (m) => typeof m !== "string" || !m.trim() || m.length > MAX_BODY_LEN,
  );
  if (invalid) {
    return NextResponse.json(
      {
        error: `Every message must be a non-empty string of ${MAX_BODY_LEN} characters or fewer.`,
      },
      { status: 400 },
    );
  }

  const posted = [];
  for (const text of messages as string[]) {
    posted.push(await addBridgedTrollboxMessage(text.trim()));
  }
  return NextResponse.json({ messages: posted }, { status: 201 });
}
