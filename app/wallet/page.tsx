"use client";

// Static, memorable entry point ("hoodchan.org/wallet") to whichever anon
// you're currently posting as - reported live as wanted so there's one URL
// to always land on your own wallet/profile page without needing to
// remember/type a specific tokenId. Not a server redirect (can't be one):
// "currently selected" is lib/usePersona.ts's sessionStorage-backed active
// persona, client-only session state with nothing server-rendering could
// read. So this is a client component that reads the same persona hook
// every other header/collection component already reads and immediately
// client-navigates to that anon's real page (app/wallet/[tokenId]/page.tsx)
// the instant it resolves.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useActivePersona } from "@/lib/usePersona";

export default function CurrentWalletRedirectPage() {
  const router = useRouter();
  const { persona } = useActivePersona();

  useEffect(() => {
    if (persona) router.replace(`/wallet/${persona.tokenId}`);
  }, [persona, router]);

  // Actively redirecting - render nothing rather than flashing the "no
  // anon selected" message below for the common case (someone who DOES
  // have one active), which would otherwise show for one render before
  // the effect above fires.
  if (persona) return null;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 gap-4 text-center">
      <h1 className="hc-title text-2xl">No anon selected</h1>
      <p className="hc-thread-meta text-sm max-w-sm">
        You&apos;re not currently posting as any anon in this browser. Pick one
        from your collection to make this link go straight to its wallet page
        from now on.
      </p>
      <Link href="/collection" className="hc-button">
        Go to your collection
      </Link>
    </div>
  );
}
