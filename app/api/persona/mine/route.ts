// Lightweight lookup for the header identity switcher (WalletHeaderWidget)
// - "which anons has this connected address claimed" without the full
// on-chain wallet scan /api/wallet-tokens does (that resolves TBA/level
// info for every held token, expensive; this is just a Redis reverse
// index read, cheap enough to call from a component that lives on every
// page).
import { NextRequest, NextResponse } from "next/server";
import { listMyClaimedTokens } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  try {
    const tokenIds = await listMyClaimedTokens(address);
    return NextResponse.json({ tokenIds });
  } catch (error) {
    console.error(`Failed to load claimed anons for ${address}`, error);
    return NextResponse.json(
      { error: "Unable to load your anons right now." },
      { status: 502 },
    );
  }
}
