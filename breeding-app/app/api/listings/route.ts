import { NextResponse } from "next/server";
import { Interface } from "ethers";
import { getContractStatus, BREEDING_CONTROLLER_CONTRACT } from "@/lib/config";
import { BreedingControllerAbi } from "@/lib/abi/BreedingController";
import { readSiringListing } from "@/lib/breedingController";
import { collectionKindOf, fetchTokenDisplay } from "@/lib/collections";
import { rpcCall, readOwnerOf } from "@/lib/chain";

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
  collection: string;
  tokenId: string;
  kind: string;
  price: string;
  name: string;
  image: string;
}

interface RawLog {
  topics: string[];
}

// ENUMERATION TRADEOFF (documented per the task spec - there is no on-chain
// enumerator; `siringListings` is a plain per-(collection,tokenId) mapping
// getter):
//
// This route indexes `SiringListed` via `eth_getLogs` (candidate discovery
// - every (collection, tokenId) that has EVER been listed, cheap: one log
// query covering the contract's whole history) and then does a LIVE
// `siringListings(collection, tokenId)` eth_call per candidate
// (authoritative current state - a delist, price change, or STALE listing
// from a since-transferred token is only visible via a fresh read, never
// trusted from the log itself - see BreedingController.SiringListing's own
// doc comment on why `lister !== ownerOf` must invalidate a stale
// listing). This is deliberately NOT a pure log-replay and NOT a
// brute-force per-collection tokenId scan over the whole supply. Tradeoff
// accepted: if an RPC provider prunes logs older than some window, a
// token listed only once, long ago, and never touched since could be
// missed - re-listing (even to the same price) refreshes discoverability.
async function discoverCandidateListings(
  controllerAddress: string,
): Promise<Array<{ collection: string; tokenId: string }>> {
  const logs = await rpcCall<RawLog[]>("eth_getLogs", [
    {
      address: controllerAddress,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [SIRING_LISTED_TOPIC0],
    },
  ]);
  const seen = new Set<string>();
  const out: Array<{ collection: string; tokenId: string }> = [];
  for (const log of logs) {
    // `collection` is topics[1], `tokenId` is topics[2] (both indexed) -
    // decode straight off the topics rather than full log decoding, same
    // convention as lib/breedingController.ts:readBredEventForBaby.
    const collectionTopic = log.topics[1];
    const tokenIdTopic = log.topics[2];
    if (!collectionTopic || !tokenIdTopic) continue;
    const collection = `0x${collectionTopic.slice(-40)}`;
    const tokenId = BigInt(tokenIdTopic).toString();
    const key = `${collection.toLowerCase()}:${tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ collection, tokenId });
  }
  return out;
}

export async function GET() {
  const status = getContractStatus();
  if (!status.breedingController) {
    return NextResponse.json({ pending: true, listings: [] });
  }

  try {
    const controllerAddress = BREEDING_CONTROLLER_CONTRACT as string;
    const candidates = await discoverCandidateListings(controllerAddress);

    const enriched = await Promise.all(
      candidates.map(
        async ({ collection, tokenId }): Promise<ListingResponse | null> => {
          try {
            const listing = await readSiringListing(collection, tokenId);
            if (!listing.listed) return null;

            const kind = collectionKindOf(collection);
            if (!kind) return null; // no longer allowlisted - stale candidate

            // ITEM 8(a): `listing.listed` alone isn't authoritative - a
            // listing survives a transfer of the underlying token (nothing
            // clears it automatically), so it must also be confirmed
            // against the token's CURRENT ownerOf before being surfaced as
            // a live, breedable candidate. Without this, a caller can spend
            // approval gas against a listing that will always revert
            // SireNotAvailable inside breed(). Dropped here rather than
            // flagged - this route only ever powers "browsable live
            // listings" (app/page.tsx, the breed page's "Listed" tab), so a
            // stale listing has no legitimate reason to appear in it.
            // clearStaleListing(collection, tokenId) is now live on-chain
            // and wired into the app (lib/breedingController.ts's
            // buildClearStaleListingTx, surfaced as a "Clear this stale
            // listing" button on the breed page next to /api/sire's
            // per-token `stale` flag) - a real connected wallet sends that
            // tx, not this server. Deliberately NOT fire-and-forget-cleared
            // from this route: doing so server-side would require a
            // funded relayer wallet and this route to broadcast
            // transactions, which is out of scope here (this route is
            // read-only against the chain).
            const owner = await readOwnerOf(collection, tokenId);
            if (owner.toLowerCase() !== listing.lister.toLowerCase()) {
              return null;
            }

            const { name, image } = await fetchTokenDisplay(
              collection,
              tokenId,
            );

            return {
              collection,
              tokenId,
              kind,
              price: listing.price.toString(),
              name,
              image,
            };
          } catch {
            return null;
          }
        },
      ),
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
