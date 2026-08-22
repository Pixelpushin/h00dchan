import { NextResponse } from "next/server";
import { fetchOwnedBreedableTokens } from "@/lib/collections";

// The connected wallet's own tokens across ALL THREE allowlisted
// collections (HOODCHAN, Girlfriends, Babies), each with live cooldown
// state - powers the breed page's matron picker (matron ownership is the
// only mandatory check, per the design spec's "Ownership rule" - so this is
// the picker's FULL candidate pool) and the "mine" tab of the sire picker.
// Generalizes the superseded v1
// app/api/wallet/[address]/girlfriends/route.ts (Girlfriends-only) to the
// symmetric matron/sire model - any owned token from any allowlisted
// collection is matron/sire-eligible, not just a Girlfriend.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  try {
    const tokens = await fetchOwnedBreedableTokens(address);
    return NextResponse.json({ tokens });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to load your wallet.",
      },
      { status: 502 },
    );
  }
}
