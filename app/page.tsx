import HomeClient from "@/app/components/HomeClient";
import { PopularThreads } from "@/app/components/PopularThreads";
import { HumanThreads } from "@/app/components/HumanThreads";
import { listActiveAds } from "@/lib/adStore";
import { listThreads } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Both independent of each other - previously awaited sequentially
  // (ads, then implicitly threads via each child component), which meant
  // the ad lookup's own latency was added on top of the thread scan's
  // instead of overlapping with it.
  const [activeAds, threads] = await Promise.all([
    listActiveAds().catch(() => []),
    listThreads().catch((err) => {
      console.error("Home: listThreads failed", err);
      return [];
    }),
  ]);
  const paidAds = activeAds.map((ad) => ({
    id: ad.id,
    name: ad.name,
    imageUrl: ad.imageUrl,
    openseaUrl: ad.openseaUrl,
  }));
  const popularThreads = (
    <>
      <HumanThreads threads={threads} />
      <PopularThreads threads={threads} />
    </>
  );
  return <HomeClient popularThreads={popularThreads} paidAds={paidAds} />;
}
