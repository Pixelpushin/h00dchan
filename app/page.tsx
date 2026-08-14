import HomeClient from "@/app/components/HomeClient";
import { PopularThreads } from "@/app/components/PopularThreads";
import { listActiveAds } from "@/lib/adStore";

export const dynamic = "force-dynamic";

export default async function Home() {
  const activeAds = await listActiveAds().catch(() => []);
  const paidAds = activeAds.map((ad) => ({
    id: ad.id,
    name: ad.name,
    imageUrl: ad.imageUrl,
    openseaUrl: ad.openseaUrl,
  }));
  return <HomeClient popularThreads={<PopularThreads />} paidAds={paidAds} />;
}
