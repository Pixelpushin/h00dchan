import { NextRequest } from "next/server";
import {
  CONTRACT,
  CHAIN_ID_HEX,
  BLOCK_EXPLORER_URL,
  readTotalSupply,
} from "@/lib/chain";
import { checkPublicApiRateLimit } from "@/lib/rate-limit";
import {
  jsonWithCors,
  rateLimitResponse,
  corsPreflightResponse,
} from "@/lib/publicApi";

// Public dev API - collection-level info. See /developers for docs and
// openapi.json for the full spec.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(request: NextRequest) {
  const limit = checkPublicApiRateLimit(request);
  if (!limit.allowed) return rateLimitResponse(limit);

  const totalSupply = await readTotalSupply().catch(() => null);

  return jsonWithCors({
    name: "HOODCHAN",
    symbol: "HC",
    contract: CONTRACT,
    chainId: Number.parseInt(CHAIN_ID_HEX, 16),
    chainIdHex: CHAIN_ID_HEX,
    chainName: "Robinhood Chain",
    totalSupply,
    maxSupply: 1200,
    explorerUrl: BLOCK_EXPLORER_URL,
    openseaUrl: `https://opensea.io/assets/robinhood/${CONTRACT}`,
  });
}
