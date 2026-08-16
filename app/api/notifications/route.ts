// "Did any of my threads/replies get new activity" badge, checked by the
// wallet header widget. GET returns whether there's something new since
// this address last looked; POST marks everything as seen (called when the
// wallet menu is opened - see app/components/WalletHeaderWidget.tsx).
//
// "My stuff" = any thread whose OP token is currently owned by this
// address. Good enough for v1: covers "someone replied to a thread I
// started" cleanly, doesn't try to track "someone replied to a reply I
// made in someone else's thread" (would need per-post ownership tracking
// this data model doesn't have yet).
import { NextRequest, NextResponse } from "next/server";
import { fetchWalletTokensOnChain } from "@/lib/chain";
import { getNotifLastSeen, listThreads, setNotifLastSeen } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  try {
    const [ownedTokenIds, threads, lastSeen] = await Promise.all([
      fetchWalletTokensOnChain(address),
      listThreads(),
      getNotifLastSeen(address),
    ]);
    const owned = new Set(ownedTokenIds);
    const lastSeenMs = lastSeen ? Date.parse(lastSeen) : 0;

    const hasNew = threads.some(
      (thread) =>
        owned.has(thread.tokenId) &&
        thread.replyCount > 0 &&
        Date.parse(thread.bumpedAt) > lastSeenMs,
    );

    return NextResponse.json({ hasNew });
  } catch (error) {
    console.error(`Failed to check notifications for ${address}`, error);
    // Fail quiet, not loud - a broken notification check should never show
    // an error state in the header, just no badge.
    return NextResponse.json({ hasNew: false });
  }
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { address } = (payload ?? {}) as Record<string, unknown>;
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  await setNotifLastSeen(address);
  return NextResponse.json({ ok: true });
}
