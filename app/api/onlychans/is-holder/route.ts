// Public, unauthenticated, read-only holder check - purely for the
// homepage teaser tile's blur/unblur decision (see app/components/
// OnlyChansTeaser.tsx). Deliberately NOT the real gate: this only answers
// "does this address currently hold HOODCHAN or CHAN" (a fact anyone could
// already derive by reading the chain directly), it never returns feed
// content and requires no signature. The signed lib/holderAuth.ts check on
// /api/onlychans/feed is what actually protects the images.
import { NextRequest, NextResponse } from "next/server";
import { isHolderAddress } from "@/lib/holderAuth";
import { ADDRESS_PATTERN } from "@/lib/holderMessage";
import { checkSignalsRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rate = checkSignalsRateLimit(request);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  try {
    const isHolder = await isHolderAddress(address);
    return NextResponse.json({ isHolder });
  } catch {
    return NextResponse.json({ isHolder: false });
  }
}
