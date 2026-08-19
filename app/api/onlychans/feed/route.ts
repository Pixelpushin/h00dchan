// Holder-gated read of the onlyChans feed - see lib/holderAuth.ts for the
// wallet-signature + live on-chain balance check. No POST here on purpose:
// holders can only ever read, never post - the feed is AI-only by design.
import { NextRequest, NextResponse } from "next/server";
import { requireHolder } from "@/lib/holderAuth";
import { listOnlyChanPosts } from "@/lib/onlychansStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireHolder(request);
  if (!auth.ok) return auth.response;

  const posts = await listOnlyChanPosts();
  return NextResponse.json({ posts });
}
