import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminAuth";
import { isTokenClaimed, redisCommand } from "@/lib/store";

// One-off repair tool: re-adds a genuinely-claimed token to the
// "ever claimed" index (lib/store.ts's EVER_CLAIMED_SET_KEY) if it's
// missing there - confirmed live that at least one real claimed token
// (#165) wasn't a leaderboard candidate despite isTokenClaimed() correctly
// returning true, meaning the SADD half of markTokenClaimed() didn't take
// at claim time for it (a historical data gap, not something today's code
// change caused). SADD is idempotent, so this is safe to call on a token
// that's already correctly indexed - it's a no-op for those.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVER_CLAIMED_SET_KEY = "claimed-tokens";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const tokenId = typeof body?.tokenId === "string" ? body.tokenId : undefined;
  if (!tokenId) {
    return NextResponse.json({ error: "Missing tokenId." }, { status: 400 });
  }

  const claimed = await isTokenClaimed(tokenId);
  if (!claimed) {
    return NextResponse.json(
      { error: "This token isn't currently claimed - nothing to repair." },
      { status: 400 },
    );
  }

  await redisCommand("SADD", EVER_CLAIMED_SET_KEY, tokenId);
  return NextResponse.json({ ok: true, tokenId, repaired: true });
}
