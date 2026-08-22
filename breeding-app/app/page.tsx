import { getContractStatus } from "@/lib/config";
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";

export const dynamic = "force-dynamic";

// Placeholder landing page - the skeleton only. Breeding flow (parent
// selection, siring price, genome computation, art generation, minting
// into the mother's TBA) lands in follow-up work per the design spec at
// docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md.
export default function Home() {
  const status = getContractStatus();

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="hc-title text-2xl">HOODCHAN Breeding</h1>
      <p className="max-w-md text-sm opacity-80">
        Breed a HOODCHAN (father) with a Girlfriend NFT (mother) to mint a
        genetically-inherited baby.
      </p>
      {!status.allDeployed && (
        <div className="max-w-md">
          <ConfigPendingNotice what="The breeding system" />
        </div>
      )}
    </main>
  );
}
