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
import { ADDRESS_PATTERN } from "@/lib/address";
import { fetchWalletTokensOnChain } from "@/lib/chain";
import { getCollectionSnapshot } from "@/lib/collectionSnapshot";
import { checkNotificationsRateLimit } from "@/lib/rate-limit";
import { getNotifLastSeen, listThreads, setNotifLastSeen } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  // Unauthenticated and does a live RPC call via fetchWalletTokensOnChain -
  // dual IP + address budget (see lib/rate-limit.ts's
  // checkNotificationsRateLimit comment: this is polled automatically
  // every 30s per connected wallet, so a single IP-only budget breaks for
  // anyone behind a shared IP with just a few concurrent real visitors).
  const rate = checkNotificationsRateLimit(request, address);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  try {
    // Same fix as /api/wallet-tokens: this used to re-derive ownership via
    // its own live eth_getLogs walk on every single poll (every 30s per
    // connected wallet - by far the most frequently-called consumer of
    // this exact query), when lib/collectionSnapshot.ts already has
    // "current owner per token" for the whole collection, cached and
    // shared. Falls back to the live scan only if the snapshot itself is
    // unavailable.
    const [snapshot, threads, lastSeen] = await Promise.all([
      getCollectionSnapshot().catch(() => null),
      listThreads(),
      getNotifLastSeen(address),
    ]);
    const ownedTokenIds = snapshot
      ? (snapshot.tokensByOwner.get(address.toLowerCase()) ?? [])
      : await fetchWalletTokensOnChain(address);
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

  // Same dual IP + address budget as GET, for consistency - this write
  // itself is cheap, but it's called from the same polling/menu-open flow.
  const rate = checkNotificationsRateLimit(request, address);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  await setNotifLastSeen(address);
  return NextResponse.json({ ok: true });
}
