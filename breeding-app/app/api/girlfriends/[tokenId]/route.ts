// baseURI target for the dummy HOODCHAN_GIRLFRIENDS collection (see
// docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md) - serves
// the committed per-token ERC-721 metadata JSON files written by
// scripts/generate-girlfriends.ts under data/girlfriends/. `force-dynamic`
// matches this repo's own convention (54 files in the parent app use it -
// e.g. app/api/token/[tokenId]/route.ts) even though the underlying data is
// static per-deploy: a contract's tokenURI(id) -> `${baseURI}${id}` call
// expects a live HTTP endpoint per token, not a build-time static export,
// and this keeps the route consistent with every other metadata-serving
// route in the ecosystem rather than a one-off exception.
//
// The real Girlfriends contract address is never referenced here - this
// route only serves metadata by tokenId, and the contract-address/baseURI
// wiring itself lives in lib/config.ts (env-driven), not in this file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { GIRLFRIEND_DEFINITIONS } from "@/lib/girlfriendsData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "data", "girlfriends");
const VALID_TOKEN_IDS = new Set(
  GIRLFRIEND_DEFINITIONS.map((def) => def.tokenId),
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const { tokenId } = await params;
  const id = Number(tokenId);

  if (!Number.isInteger(id) || !VALID_TOKEN_IDS.has(id)) {
    return NextResponse.json({ error: "Invalid token ID." }, { status: 400 });
  }

  try {
    const raw = readFileSync(path.join(DATA_DIR, `${id}.json`), "utf8");
    return NextResponse.json(JSON.parse(raw), {
      headers: {
        // Same reasoning as app/api/token/[tokenId]/route.ts: metadata is
        // immutable once generated, so this is safe to cache at any proxy
        // that respects the header even though `force-dynamic` opts this
        // route itself out of Vercel's own CDN caching.
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error(`Failed to read Girlfriend #${id} metadata`, error);
    return NextResponse.json(
      { error: "Unable to resolve token metadata." },
      { status: 404 },
    );
  }
}
