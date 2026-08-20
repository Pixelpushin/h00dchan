import { NextRequest, NextResponse } from "next/server";
import { resolveEnsName } from "@/lib/ens";
import { checkPublicApiRateLimit } from "@/lib/rate-limit";

// Resolves an ENS name server-side so WalletActionsPanel (a client
// component) never touches ALCHEMY_API_KEY directly - same pattern as
// app/api/token/[tokenId]/route.ts. force-dynamic since resolution results
// can change (a name can be re-pointed at a different address).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Unauthenticated and proxies straight through to Alchemy - IP-keyed so
  // a flood here can't run up the upstream Alchemy bill or trip its own
  // rate limiting for every user sharing this deployment.
  const rate = checkPublicApiRateLimit(request);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const name = request.nextUrl.searchParams.get("name")?.trim();
  if (!name) {
    return NextResponse.json({ error: "Missing name." }, { status: 400 });
  }

  try {
    const address = await resolveEnsName(name);
    return NextResponse.json({ address });
  } catch (error) {
    console.error(`Failed to resolve ENS name "${name}"`, error);
    return NextResponse.json(
      { error: "Unable to resolve ENS name right now." },
      { status: 502 },
    );
  }
}
