// Family-tree data: parents, siblings, children, and deeper descendants,
// all read off the v2 `Bred` event log - both parent (collection, id) pairs
// are emitted directly on that event (see lib/breedingController.ts's
// BredEventResult), so unlike the superseded v1 design there is no
// `parentsOf()` getter needed anywhere; this file generalizes the existing
// readBredEventForBaby single-token scan pattern to a scan BY PARENT.
//
// ENUMERATION NOTE: only `babyTokenId` is indexed on `Bred`
// (matronCollection/matronId/sireCollection/sireId are not - see the real
// ABI), so there is no topic-filtered way to ask "every Bred event where
// token X was a parent" directly from the node. This does the same
// full-history `eth_getLogs` scan (topic0 only) + local decode + filter
// that app/api/listings/route.ts already does for `SiringListed` - same
// tradeoff accepted there applies here (a pruning RPC provider could in
// theory drop very old logs; not expected to matter at this app's scale).
import { rpcCall } from "@/lib/chain";
import { BABIES_CONTRACT } from "@/lib/config";
import {
  BRED_EVENT_TOPIC0,
  parseBredEventFromLogs,
  requireController,
  type BredEventResult,
  type RawLog,
} from "@/lib/breedingController";

// Every Bred event ever emitted by the configured controller - the shared
// raw dataset every lineage query below filters locally, so a page needing
// multiple relationships (parents + siblings + children + descendants) only
// pays for one scan.
export async function scanAllBredEvents(): Promise<BredEventResult[]> {
  const contract = requireController();
  const logs = await rpcCall<RawLog[]>("eth_getLogs", [
    {
      address: contract,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [BRED_EVENT_TOPIC0],
    },
  ]);
  const out: BredEventResult[] = [];
  for (const log of logs) {
    // Re-verify through parseBredEventFromLogs (one log at a time) so this
    // shares the exact same BUG 5(a) address+topic0 check as every other
    // Bred-event consumer, even though the eth_getLogs query above already
    // filtered by address.
    const parsed = parseBredEventFromLogs([log], contract);
    if (parsed) out.push(parsed);
  }
  return out;
}

function isParent(
  event: BredEventResult,
  collection: string,
  tokenId: string,
): boolean {
  const lower = collection.toLowerCase();
  return (
    (event.matronCollection.toLowerCase() === lower &&
      event.matronId === tokenId) ||
    (event.sireCollection.toLowerCase() === lower && event.sireId === tokenId)
  );
}

function sameParentPair(a: BredEventResult, b: BredEventResult): boolean {
  return (
    a.matronCollection.toLowerCase() === b.matronCollection.toLowerCase() &&
    a.matronId === b.matronId &&
    a.sireCollection.toLowerCase() === b.sireCollection.toLowerCase() &&
    a.sireId === b.sireId
  );
}

export interface FamilyTree {
  /** This token's own birth event - only present when `collection` is
   * HOODCHAN_BABIES (every non-Baby root is a first-generation ancestor by
   * construction, never itself bred). */
  ownBirth: BredEventResult | null;
  /** Other babies sharing BOTH of this token's parents, when `ownBirth` is
   * known - excludes this token itself. */
  siblings: BredEventResult[];
  /** Every breed where this token participated as matron OR sire - i.e.
   * this token's direct children. */
  children: BredEventResult[];
  /** Children-of-children, grandchildren-of-children, etc, breadth-first,
   * flattened - every event is guaranteed to be a real descendant since a
   * child can only ever be bred using its OWN babyTokenId as a (collection,
   * id) parent pair after it exists, so this can never cycle back to an
   * ancestor. Capped at a generous depth as a hygiene backstop, not because
   * a real cycle is possible. */
  descendants: BredEventResult[];
}

const MAX_DESCENDANT_DEPTH = 20;

export async function loadFamilyTree(
  collection: string,
  tokenId: string,
): Promise<FamilyTree> {
  const all = await scanAllBredEvents();

  const isBaby = Boolean(
    BABIES_CONTRACT &&
    collection.toLowerCase() === BABIES_CONTRACT.toLowerCase(),
  );
  const ownBirth = isBaby
    ? (all.find((e) => e.babyTokenId === tokenId) ?? null)
    : null;

  const siblings = ownBirth
    ? all.filter(
        (e) => e.babyTokenId !== tokenId && sameParentPair(e, ownBirth),
      )
    : [];

  const children = all.filter((e) => isParent(e, collection, tokenId));

  const babiesContract = BABIES_CONTRACT;
  const descendants: BredEventResult[] = [];
  const seenBabyIds = new Set(children.map((e) => e.babyTokenId));
  let frontier = children;
  let depth = 0;
  while (
    babiesContract &&
    frontier.length > 0 &&
    depth < MAX_DESCENDANT_DEPTH
  ) {
    const next: BredEventResult[] = [];
    for (const parentEvent of frontier) {
      const grandchildren = all.filter((e) =>
        isParent(e, babiesContract, parentEvent.babyTokenId),
      );
      for (const g of grandchildren) {
        if (seenBabyIds.has(g.babyTokenId)) continue;
        seenBabyIds.add(g.babyTokenId);
        descendants.push(g);
        next.push(g);
      }
    }
    frontier = next;
    depth += 1;
  }

  return { ownBirth, siblings, children, descendants };
}
