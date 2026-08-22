import { NextResponse } from "next/server";
import { getContractStatus } from "@/lib/config";
import {
  readBirthFee,
  readSameSexFeeMultiplier,
} from "@/lib/breedingController";

// Live BreedingController fee config - `birthFee()` / `sameSexFeeMultiplier()`
// are both owner-configurable post-deploy (setBirthFee/
// setSameSexFeeMultiplier), so lib/config.ts's DEFAULT_BIRTH_FEE /
// DEFAULT_SAME_SEX_FEE_MULTIPLIER can silently drift from the real deployed
// values. This route is the one place that reads the live values server-side
// (same "reads happen in an API route, client just fetches JSON" convention
// as app/api/sire/[collection]/[tokenId]/route.ts and app/api/listings) so
// app/breed/[collection]/[tokenId]/page.tsx can wire them into both the fee
// preview AND the CHAN approval amount instead of trusting the pre-deploy
// constants for either.
export const dynamic = "force-dynamic";

export async function GET() {
  const status = getContractStatus();
  if (!status.breedingController) {
    return NextResponse.json({ pending: true });
  }

  try {
    const [birthFee, sameSexFeeMultiplier] = await Promise.all([
      readBirthFee(),
      readSameSexFeeMultiplier(),
    ]);
    return NextResponse.json({
      pending: false,
      birthFee: birthFee.toString(),
      sameSexFeeMultiplier: sameSexFeeMultiplier.toString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        pending: false,
        error:
          err instanceof Error ? err.message : "Failed to load fee config.",
      },
      { status: 502 },
    );
  }
}
