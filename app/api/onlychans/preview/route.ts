// Public, unauthenticated, read-only preview of the last few onlyChans
// post images - purely for the homepage board-preview card (see app/
// components/OnlyChansPreview.tsx), which blurs them client-side via CSS
// until the connected wallet is confirmed a holder. Same "not the real
// gate" reasoning as ../is-holder: the real feed content itself is low-
// stakes satire, not sensitive data, so a plain public read here (same as
// PopularThreads' server-side read of real board threads) is fine - the
// signed lib/holderAuth.ts session on /api/onlychans/feed is what governs
// the actual /onlychans page.
import { NextResponse } from "next/server";
import { listOnlyChanPosts } from "@/lib/onlychansStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_COUNT = 6;

export async function GET() {
  const posts = await listOnlyChanPosts(PREVIEW_COUNT);
  return NextResponse.json({
    posts: posts.map((p) => ({ id: p.id, imageUrl: p.imageUrl })),
  });
}
