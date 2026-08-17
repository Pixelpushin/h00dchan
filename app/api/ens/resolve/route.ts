import { NextRequest, NextResponse } from "next/server";
import { resolveEnsName } from "@/lib/ens";

// Resolves an ENS name server-side so WalletActionsPanel (a client
// component) never touches ALCHEMY_API_KEY directly - same pattern as
// app/api/token/[tokenId]/route.ts. force-dynamic since resolution results
// can change (a name can be re-pointed at a different address).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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
