import { NextResponse } from "next/server";
import { Interface } from "ethers";
import { getContractStatus, BREEDING_CONTROLLER_CONTRACT } from "@/lib/config";
import { BreedingControllerAbi } from "@/lib/abi/BreedingController";
import { readSiringListing } from "@/lib/breedingController";
import { fetchHoodchanMetadata, isUpgraded } from "@/lib/hoodchan";
import { readUpgradedAllowlist } from "@/lib/breedingController";
import { rpcCall } from "@/lib/chain";

// Reads live chain state on every request - siring listings and prices can
// change at any moment, and this is the browse-all-sires page's only data
// source.
export const dynamic = "force-dynamic";

const controllerInterface = new Interface(BreedingControllerAbi);
const siringListedFragment = controllerInterface.getEvent("SiringListed");
if (!siringListedFragment) {
  throw new Error("BreedingController ABI is missing the SiringListed event.");
}
const SIRING_LISTED_TOPIC0 = siringListedFragment.topicHash;

export interface ListingResponse {
  hoodchanId: string;
  chanPrice: string;
  ethPrice: string;
  ethEligible: boolean;
  name: string;
  image: string;
}

interface RawLog {
  topics: string[];
}

// ENUMERATION TRADEOFF (documented per the task spec - there is no on-chain
// enumerator; `siringListings` is a plain per-tokenId mapping getter):
//
// This route indexes `SiringListed` via `eth_getLogs` (candidate discovery
// - every fatherTokenId that has EVER been listed, cheap: one log query
// covering the contract's whole history) and then does a LIVE
// `siringListings(id)` eth_call per candidate (authoritative current state -
// a delist or a price change is only visible via a fresh read, never
// trusted from the log itself). This is deliberately NOT a pure log-replay
// (which would require correctly ordering SiringListed/SiringDelisted by
// (blockNumber, logIndex) and would still only be as fresh as the RPC's
// log retention) and NOT a brute-force `siringListings(1..~1200)` mapping
// scan over the whole HOODCHAN supply (which is correct and enumerator-free
// but wastes ~1200 eth_calls on tokens that were never listed at all).
// Concretely: O(historicalListers) eth_calls instead of O(totalSupply) or
// O(1)-but-log-retention-dependent. Tradeoff accepted: if an RPC provider
// prunes logs older than some window, a father listed only once, long ago,
// and never touched since could be missed - re-listing (even to the same
// price) refreshes discoverability.
async function discoverCandidateFatherIds(
  controllerAddress: string,
): Promise<string[]> {
  const logs = await rpcCall<RawLog[]>("eth_getLogs", [
    {
      address: controllerAddress,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [SIRING_LISTED_TOPIC0],
    },
  ]);
  const ids = new Set<string>();
  for (const log of logs) {
    // fatherTokenId is topics[1] (indexed) - decode straight off the topic
    // rather than full log decoding, same convention as
    // lib/breedingController.ts:readBredEventForBaby.
    const topic = log.topics[1];
    if (topic) ids.add(BigInt(topic).toString());
  }
  return [...ids];
}

export async function GET() {
  const status = getContractStatus();
  if (!status.breedingController) {
    return NextResponse.json({ pending: true, listings: [] });
  }

  try {
    const controllerAddress = BREEDING_CONTROLLER_CONTRACT as string;
    const candidateIds = await discoverCandidateFatherIds(controllerAddress);

    const enriched = await Promise.all(
      candidateIds.map(async (hoodchanId): Promise<ListingResponse | null> => {
        try {
          const [listing, upgraded, metadata] = await Promise.all([
            readSiringListing(hoodchanId),
            readUpgradedAllowlist(hoodchanId),
            fetchHoodchanMetadata(hoodchanId),
          ]);
          if (!listing.listed) return null;
          return {
            hoodchanId,
            chanPrice: listing.chanPrice.toString(),
            ethPrice: listing.ethPrice.toString(),
            // ETH badge only when BOTH the on-chain allowlist AND the
            // token's own live tokenURI metadata still carry
            // STATUS:"Upgraded" - two independent signals, never just one
            // (see lib/hoodchan.ts's header on why tokenURI is now the
            // primary source and the allowlist is the contract's own
            // synced copy of it).
            ethEligible:
              listing.ethPrice > 0n && upgraded && isUpgraded(metadata),
            name: metadata.name,
            image: metadata.image,
          };
        } catch {
          return null;
        }
      }),
    );

    return NextResponse.json({
      pending: false,
      listings: enriched.filter((l): l is ListingResponse => l !== null),
    });
  } catch (err) {
    return NextResponse.json(
      {
        pending: false,
        listings: [],
        error: err instanceof Error ? err.message : "Failed to load listings.",
      },
      { status: 502 },
    );
  }
}
