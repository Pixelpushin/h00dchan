import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import { createThread, listThreads } from "@/lib/store";

// Node runtime (not edge) - needed for ethers' verifyMessage in
// lib/auth-server.ts, same reasoning as app/api/token/[tokenId]/route.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUBJECT_LEN = 100;
const MAX_BODY_LEN = 4000;

export async function GET() {
  try {
    const threads = await listThreads();
    // Most-recently-bumped first, same convention as any imageboard board
    // index.
    const payload = [...threads].sort(
      (a, b) => Date.parse(b.bumpedAt) - Date.parse(a.bumpedAt),
    );
    return NextResponse.json({ threads: payload });
  } catch (error) {
    console.error("Failed to list threads", error);
    return NextResponse.json(
      { error: "Unable to list threads." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { subject, body, tokenId, address, signature, issuedAt } = (payload ??
    {}) as Record<string, unknown>;

  if (
    typeof subject !== "string" ||
    !subject.trim() ||
    typeof body !== "string" ||
    !body.trim() ||
    typeof tokenId !== "string" ||
    typeof address !== "string" ||
    typeof signature !== "string" ||
    typeof issuedAt !== "string"
  ) {
    return NextResponse.json(
      { error: "Missing or invalid fields." },
      { status: 400 },
    );
  }

  if (subject.length > MAX_SUBJECT_LEN) {
    return NextResponse.json(
      { error: `Subject must be ${MAX_SUBJECT_LEN} characters or fewer.` },
      { status: 400 },
    );
  }
  if (body.length > MAX_BODY_LEN) {
    return NextResponse.json(
      { error: `Body must be ${MAX_BODY_LEN} characters or fewer.` },
      { status: 400 },
    );
  }

  const verification = await verifyPersonaClaim({
    tokenId,
    address,
    signature,
    issuedAt,
  });
  if (!verification.ok) {
    return NextResponse.json(
      { error: verification.reason ?? "Not authorized." },
      { status: 403 },
    );
  }

  const { thread, post } = await createThread(
    subject.trim(),
    tokenId,
    body.trim(),
  );
  return NextResponse.json({ thread, post }, { status: 201 });
}
