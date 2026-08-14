import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import { checkWriteRateLimit } from "@/lib/rate-limit";
import { addReply, getThread, listPosts, markTokenClaimed } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_LEN = 4000;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  try {
    const thread = await getThread(threadId);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found." }, { status: 404 });
    }
    const posts = await listPosts(threadId);
    return NextResponse.json({ thread, posts });
  } catch (error) {
    console.error(`Failed to list posts for thread ${threadId}`, error);
    return NextResponse.json(
      { error: "Unable to list posts." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;

  const thread = await getThread(threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { body, tokenId, address, signature, issuedAt } = (payload ??
    {}) as Record<string, unknown>;

  if (
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

  if (body.length > MAX_BODY_LEN) {
    return NextResponse.json(
      { error: `Body must be ${MAX_BODY_LEN} characters or fewer.` },
      { status: 400 },
    );
  }

  const rate = checkWriteRateLimit(request, address, tokenId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
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
      {
        error: verification.reason ?? "Not authorized.",
        code: verification.code,
      },
      { status: 403 },
    );
  }

  // See app/api/threads/route.ts for why this happens right after a
  // successful verifyPersonaClaim.
  await markTokenClaimed(tokenId, address);

  const post = await addReply(threadId, tokenId, body.trim());
  return NextResponse.json({ post }, { status: 201 });
}
