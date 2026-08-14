import { NextRequest, NextResponse } from "next/server";
import { getOrFetchTokenMetadata } from "@/lib/store";

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
//
// Also checks lib/store.ts's permanent KV cache before ever touching IPFS -
// this route is `force-dynamic`, which means Vercel's edge does NOT cache
// it despite the Cache-Control header below (that header only matters for
// clients/proxies that actually see it, which a force-dynamic serverless
// function's callers do, just not Vercel's own CDN in front of it). Without
// the KV cache, every page load from every user re-fetched from a public
// IPFS gateway - verified live in production causing intermittent 502s on
// a token that resolved fine moments later. Metadata is immutable once
// minted, so caching it forever after the first successful resolution is
// correct, not just a performance shortcut.
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
    const metadata = await getOrFetchTokenMetadata(String(id));
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
