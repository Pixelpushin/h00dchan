// Family-tree page (net-new) - parents, siblings, children, and deeper
// descendants for any token from any allowlisted collection, read straight
// off the v2 `Bred` event log (see lib/lineage.ts's header: both parent
// (collection, id) pairs are emitted directly on that event, so this needs
// no separate parentsOf() getter). Server component, same "no separate API
// route, direct lib calls in the component" convention as
// app/baby/[tokenId]/page.tsx.
//
// Rate-limited the same way as app/api/breed/[txHash]/route.ts (design
// spec's hygiene requirements - "the public route needs basic
// rate-limiting/auth regardless of the fee throttle - belt and suspenders")
// since `loadFamilyTree` does a full-history eth_getLogs scan of every Bred
// event ever emitted, the single most expensive read in this app, and this
// page is reachable with nothing more than a syntactically valid
// (collection, tokenId) pair in the URL.
import { headers } from "next/headers";
import Link from "next/link";
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";
import { getContractStatus, BABIES_CONTRACT } from "@/lib/config";
import {
  collectionKindOf,
  collectionLabel,
  fetchTokenDisplay,
} from "@/lib/collections";
import { loadFamilyTree, type FamilyTree } from "@/lib/lineage";
import type { BredEventResult } from "@/lib/breedingController";
import { checkExpensiveScanRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

function isBabyCollection(collection: string): boolean {
  return Boolean(
    BABIES_CONTRACT &&
    collection.toLowerCase() === BABIES_CONTRACT.toLowerCase(),
  );
}

interface CardData {
  collection: string;
  tokenId: string;
  name: string;
  image: string;
}

async function loadCard(
  collection: string,
  tokenId: string,
): Promise<CardData> {
  const display = await fetchTokenDisplay(collection, tokenId).catch(() => ({
    name: `${collectionLabel(collection)} #${tokenId}`,
    image: "",
  }));
  return { collection, tokenId, name: display.name, image: display.image };
}

function TokenCard({ card }: { card: CardData }) {
  const isBaby = isBabyCollection(card.collection);
  return (
    <div className="hc-card">
      {card.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.image}
          alt={card.name}
          className="w-full aspect-square object-cover"
        />
      ) : (
        <div
          className="w-full aspect-square flex items-center justify-center text-xs"
          style={{ background: "var(--hc-box-alt)", color: "var(--hc-muted)" }}
        >
          {isBaby ? "Art generating" : "No image"}
        </div>
      )}
      <div className="hc-card-body">
        <span className="font-bold text-sm truncate">{card.name}</span>
        <span className="hc-badge">{collectionLabel(card.collection)}</span>
        <div className="flex gap-2">
          {isBaby && (
            <Link href={`/baby/${card.tokenId}`} className="hc-link text-xs">
              Offspring detail
            </Link>
          )}
          <Link
            href={`/family/${card.collection}/${card.tokenId}`}
            className="hc-link text-xs"
          >
            Family tree
          </Link>
        </div>
      </div>
    </div>
  );
}

async function cardsForBabyIds(babyIds: string[]): Promise<CardData[]> {
  const babiesContract = BABIES_CONTRACT;
  if (!babiesContract) return [];
  return Promise.all(babyIds.map((id) => loadCard(babiesContract, id)));
}

export default async function FamilyTreePage({
  params,
}: {
  params: Promise<{ collection: string; tokenId: string }>;
}) {
  const { collection, tokenId } = await params;
  const status = getContractStatus();

  if (!status.breedingController) {
    return (
      <main className="mx-auto max-w-4xl w-full px-4 py-6">
        <ConfigPendingNotice what="The BreedingController contract" />
      </main>
    );
  }

  const kind = collectionKindOf(collection);
  if (!kind) {
    return (
      <main className="mx-auto max-w-4xl w-full px-4 py-6">
        <div className="hc-error-box">
          Not an allowlisted breedable collection: {collection}
        </div>
      </main>
    );
  }

  const rateLimit = checkExpensiveScanRateLimit(await headers());
  if (!rateLimit.allowed) {
    return (
      <main className="mx-auto max-w-4xl w-full px-4 py-6">
        <div className="hc-error-box">
          Too many requests - slow down and reload again shortly.
        </div>
      </main>
    );
  }

  let tree: FamilyTree;
  try {
    tree = await loadFamilyTree(collection, tokenId);
  } catch (err) {
    return (
      <main className="mx-auto max-w-4xl w-full px-4 py-6">
        <div className="hc-error-box">
          {err instanceof Error ? err.message : "Failed to load family tree."}
        </div>
      </main>
    );
  }

  const self = await loadCard(collection, tokenId);

  const parentPairFor = (
    e: BredEventResult,
  ): [
    { collection: string; tokenId: string },
    { collection: string; tokenId: string },
  ] => [
    { collection: e.matronCollection, tokenId: e.matronId },
    { collection: e.sireCollection, tokenId: e.sireId },
  ];

  const parentCards = tree.ownBirth
    ? await Promise.all(
        parentPairFor(tree.ownBirth).map((p) =>
          loadCard(p.collection, p.tokenId),
        ),
      )
    : [];

  const siblingCards = await cardsForBabyIds(
    tree.siblings.map((e) => e.babyTokenId),
  );
  const childCards = await cardsForBabyIds(
    tree.children.map((e) => e.babyTokenId),
  );
  const descendantCards = await cardsForBabyIds(
    tree.descendants.map((e) => e.babyTokenId),
  );

  return (
    <main className="mx-auto max-w-4xl w-full px-4 py-6 flex flex-col gap-6">
      <div>
        <h1 className="hc-title text-2xl">Family tree</h1>
        <p className="text-sm mt-1" style={{ color: "var(--hc-muted)" }}>
          {self.name} ({collectionLabel(collection)} #{tokenId})
        </p>
      </div>

      {tree.ownBirth && (
        <section>
          <h2 className="hc-title text-lg mb-2">Parents</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {parentCards.map((c) => (
              <TokenCard key={`${c.collection}-${c.tokenId}`} card={c} />
            ))}
          </div>
        </section>
      )}

      {tree.ownBirth && (
        <section>
          <h2 className="hc-title text-lg mb-2">Siblings</h2>
          {siblingCards.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
              No other offspring share both of these parents yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {siblingCards.map((c) => (
                <TokenCard key={`${c.collection}-${c.tokenId}`} card={c} />
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="hc-title text-lg mb-2">Children</h2>
        {childCards.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
            This token hasn&apos;t sired or mothered any offspring yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {childCards.map((c) => (
              <TokenCard key={`${c.collection}-${c.tokenId}`} card={c} />
            ))}
          </div>
        )}
      </section>

      {descendantCards.length > 0 && (
        <section>
          <h2 className="hc-title text-lg mb-2">
            Further descendants ({descendantCards.length})
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {descendantCards.map((c) => (
              <TokenCard key={`${c.collection}-${c.tokenId}`} card={c} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
