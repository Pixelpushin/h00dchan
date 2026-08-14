import { NextRequest, NextResponse } from "next/server";
import { fetchTokenMetadata } from "@/lib/chain";

// Resolves HOODCHAN token metadata server-side and hands the client clean
// JSON. This exists because IPFS gateways proved inconsistent about CORS on
// intermediate redirect hops when fetch()'d directly from the browser
// (verified live: nftstorage.link's first 302 hop had no
// access-control-allow-origin header even though its final 200 did, which
// browsers can reject depending on redirect handling) - server-to-server
// fetches have no CORS restriction at all, so resolving here sidesteps the
// whole class of gateway-CORS flakiness instead of chasing it gateway by
// gateway. On-chain reads (ownerOf, tokenURI, Transfer logs) stay
// client-side since the Robinhood Chain RPC was verified to already allow
// cross-origin requests.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const { tokenId } = await params;
  const id = Number(tokenId);

  if (!Number.isInteger(id) || id < 1 || id > 1200) {
    return NextResponse.json({ error: "Invalid token ID." }, { status: 400 });
  }

  try {
    const metadata = await fetchTokenMetadata(id);
    return NextResponse.json(metadata, {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error(`Failed to resolve HOODCHAN #${id} metadata`, error);
    return NextResponse.json(
      { error: "Unable to resolve token metadata." },
      { status: 502 },
    );
  }
}
