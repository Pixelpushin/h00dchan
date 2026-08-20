import { NextRequest } from "next/server";
import { ADDRESS_PATTERN } from "@/lib/address";
import { readBalanceOf } from "@/lib/chain";
import { checkPublicApiRateLimit } from "@/lib/rate-limit";
import { listRegistryEntries } from "@/lib/registryStore";
import {
  jsonWithCors,
  rateLimitResponse,
  corsPreflightResponse,
} from "@/lib/publicApi";

// The actual "automated mutual whitelisting" primitive: given a wallet
// address, which CircleJerkFinance-registered community projects does it
// currently hold >=1 of. Any registry-listed project can call this to
// auto-whitelist "holds anything else in the community registry" without
// hand-maintaining its own copy of every other project's holder list.
//
// balanceOf(address) has the identical selector/return shape on both
// ERC-721 and ERC-20 (see lib/chain.ts's readBalanceOf) - one live eth_call
// per registry entry, bounded by however many projects are actually
// listed (community-curated, expected small), same cost class as the
// TRUSTED_TOKENS check already done per-request on the wallet page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const limit = checkPublicApiRateLimit(request);
  if (!limit.allowed) return rateLimitResponse(limit);

  const { address } = await params;
  if (!ADDRESS_PATTERN.test(address)) {
    return jsonWithCors({ error: "Invalid address." }, { status: 400 });
  }

  try {
    const entries = await listRegistryEntries();
    const balances = await Promise.all(
      entries.map((entry) =>
        readBalanceOf(entry.contractAddress, address).catch(() => BigInt(0)),
      ),
    );
    const holds = entries
      .filter((_, i) => balances[i] > BigInt(0))
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        contractAddress: entry.contractAddress,
        url: entry.url,
      }));
    return jsonWithCors({ address, holds });
  } catch {
    return jsonWithCors(
      { error: "Unable to resolve registry holdings right now." },
      { status: 502 },
    );
  }
}
