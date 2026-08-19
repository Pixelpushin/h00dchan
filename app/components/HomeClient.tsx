import type { ReactNode } from "react";
import { AdBanner, type PaidAd } from "@/app/components/AdBanner";
import { RentAdSpaceButton } from "@/app/components/RentAdSpaceButton";
import { OnlyChansPreview } from "@/app/components/OnlyChansPreview";

// Home page body - deliberately just board content and links now, nothing
// wallet-related. The claim/activate token grid that used to live here
// (gated behind a connected wallet) moved to its own page
// (app/collection/page.tsx), reachable from the header's wallet widget -
// reported live that a connected wallet's home screen was dominated by
// that grid instead of behaving like a normal, freely-browsable
// imageboard front page. No "use client" here anymore either: nothing
// left in this component needs client-side state directly (AdBanner/
// RentAdSpaceButton/OnlyChansPreview are each already their own client
// islands), so this can go back to being plain server-rendered layout.
//
// OnlyChansPreview sits below popularThreads, not above the ad banner -
// it's another board's preview card (same shape as PopularThreads), so it
// belongs with the other board previews, not competing with the ad slot
// for top-of-page real estate.
export default function HomeClient({
  popularThreads,
  paidAds,
}: {
  popularThreads: ReactNode;
  paidAds: PaidAd[];
}) {
  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-5xl flex-col items-center px-6 py-10">
        <div className="flex w-full justify-end mb-2">
          <RentAdSpaceButton />
        </div>
        <AdBanner paidAds={paidAds} />
        <div className="w-full">{popularThreads}</div>
        <OnlyChansPreview />
      </main>
    </div>
  );
}
