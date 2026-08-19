import HomeClient from "@/app/components/HomeClient";
import { PopularThreads } from "@/app/components/PopularThreads";
import { HumanThreads } from "@/app/components/HumanThreads";
import { listActiveAds } from "@/lib/adStore";
import { listThreads, getCachedTokenMetadata } from "@/lib/store";

export const dynamic = "force-dynamic";

const TOTAL_SUPPLY = 1200;
// Tokens #1-5 are excluded on purpose - "over the top" content the
// collection's own early pieces have, not something that should show up
// as decorative filler on a paid ad banner regardless of how it's picked.
const EXCLUDED_TOKEN_IDS = new Set(["1", "2", "3", "4", "5"]);
const POOL_SIZE = 12;

// A random pool of HOODCHAN tokens - purely decorative filler on the
// sides of a paid ad banner whose own image doesn't fill the ultra-wide
// 1168:198 slot, so the black pillars either side of it become a small
// rotating showcase of the collection instead of empty space. Previously
// this was a fixed pair (the two rarest, by rarity-index rank) - swapped
// for a genuinely random pool that AdBanner.tsx re-samples on every
// rotation, so the flanking pair actually cycles/changes over time
// instead of always being the same two tokens. Reads from the cache only
// (getCachedTokenMetadata, no IPFS fallback) - fast, and misses are fine
// here since this is decoration, not something that needs to succeed.
async function fetchRandomTokenPool(): Promise<
  Array<{ tokenId: string; imageUrl: string }>
> {
  const candidateIds = new Set<string>();
  // Oversample a bit - some picks will miss the cache or land on an
  // excluded id, so drawing more than POOL_SIZE up front avoids a slow
  // retry-until-full loop.
  while (candidateIds.size < POOL_SIZE * 3) {
    const id = String(1 + Math.floor(Math.random() * TOTAL_SUPPLY));
    if (!EXCLUDED_TOKEN_IDS.has(id)) candidateIds.add(id);
  }

  const withMetadata = await Promise.all(
    [...candidateIds].map(async (tokenId) => ({
      tokenId,
      metadata: await getCachedTokenMetadata(tokenId).catch(() => null),
    })),
  );
  return withMetadata
    .filter(
      (t): t is { tokenId: string; metadata: NonNullable<typeof t.metadata> } =>
        t.metadata !== null,
    )
    .slice(0, POOL_SIZE)
    .map((t) => ({ tokenId: t.tokenId, imageUrl: t.metadata.image }));
}

export default async function Home() {
  // All independent of each other - previously awaited sequentially
  // (ads, then implicitly threads via each child component), which meant
  // the ad lookup's own latency was added on top of the thread scan's
  // instead of overlapping with it.
  const [activeAds, threads, randomTokenPool] = await Promise.all([
    listActiveAds().catch(() => []),
    listThreads().catch((err) => {
      console.error("Home: listThreads failed", err);
      return [];
    }),
    fetchRandomTokenPool().catch(() => []),
  ]);
  const paidAds = activeAds.map((ad) => ({
    id: ad.id,
    name: ad.name,
    imageUrl: ad.imageUrl,
    avatarUrl: ad.avatarUrl || ad.imageUrl,
    openseaUrl: ad.openseaUrl,
  }));
  const popularThreads = (
    <>
      <HumanThreads threads={threads} />
      <PopularThreads threads={threads} />
    </>
  );
  return (
    <HomeClient
      popularThreads={popularThreads}
      paidAds={paidAds}
      randomTokenPool={randomTokenPool}
    />
  );
}
