import HomeClient from "@/app/components/HomeClient";
import { PopularThreads } from "@/app/components/PopularThreads";
import { HumanThreads } from "@/app/components/HumanThreads";
import { listActiveAds } from "@/lib/adStore";
import {
  listThreads,
  readRarityIndex,
  getOrFetchTokenMetadata,
} from "@/lib/store";

export const dynamic = "force-dynamic";

// The two rarest HOODCHAN tokens (rarity-index rank 1 and 2) - used purely
// as decorative filler on the sides of a paid ad banner whose own image
// doesn't fill the ultra-wide 1168:198 slot, so the black pillars either
// side of it become a small showcase of the collection instead of empty
// space. Only ever 2 - see AdBanner.tsx for why more would be superfluous
// (there's only a left and right side to fill).
async function fetchRarestTokenThumbnails(): Promise<
  Array<{ tokenId: string; imageUrl: string }>
> {
  const index = await readRarityIndex().catch(() => null);
  if (!index) return [];
  const rarestIds = Object.entries(index.entries)
    .filter(([, entry]) => entry.rank === 1 || entry.rank === 2)
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([tokenId]) => tokenId);
  const withMetadata = await Promise.all(
    rarestIds.map(async (tokenId) => ({
      tokenId,
      metadata: await getOrFetchTokenMetadata(tokenId).catch(() => null),
    })),
  );
  return withMetadata
    .filter(
      (t): t is { tokenId: string; metadata: NonNullable<typeof t.metadata> } =>
        t.metadata !== null,
    )
    .map((t) => ({ tokenId: t.tokenId, imageUrl: t.metadata.image }));
}

export default async function Home() {
  // All independent of each other - previously awaited sequentially
  // (ads, then implicitly threads via each child component), which meant
  // the ad lookup's own latency was added on top of the thread scan's
  // instead of overlapping with it.
  const [activeAds, threads, rarestTokens] = await Promise.all([
    listActiveAds().catch(() => []),
    listThreads().catch((err) => {
      console.error("Home: listThreads failed", err);
      return [];
    }),
    fetchRarestTokenThumbnails().catch(() => []),
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
      rarestTokens={rarestTokens}
    />
  );
}
