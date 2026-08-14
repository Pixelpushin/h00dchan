import HomeClient from "@/app/components/HomeClient";
import { PopularThreads } from "@/app/components/PopularThreads";

export const dynamic = "force-dynamic";

export default function Home() {
  return <HomeClient popularThreads={<PopularThreads />} />;
}
