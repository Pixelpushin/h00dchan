import Link from "next/link";
import { WalletHeaderWidget } from "@/app/components/WalletHeaderWidget";

// Same header-band skin/pattern as the parent h00dchan app's own
// SiteHeader, copy-adapted (not imported) since this is a separate
// project. Links back to the main site with the exact same plain external
// <a target="_blank"> pattern that app/components/SiteHeader.tsx uses for
// its own "Fight" link over there (this task's own single allowed touch to
// that file adds the mirror-image link back to here).
export function SiteHeader() {
  return (
    <header className="hc-header-band">
      <div className="mx-auto flex max-w-5xl flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <div>
            <Link href="/" className="hc-wordmark leading-none">
              hoodchan breeding
            </Link>
            <p className="hc-tagline mt-0.5">
              sire your anon, raise the offspring
            </p>
          </div>
          <WalletHeaderWidget />
        </div>
        <nav className="hc-nav flex flex-wrap items-center gap-2 sm:gap-4 pb-1">
          <Link href="/">browse sires</Link>
          <Link href="/my">my girls</Link>
          <a
            href="https://h00dchan.xyz/"
            target="_blank"
            rel="noopener noreferrer"
          >
            h00dchan
          </a>
          <a
            href="https://fight.hoodchan.org/"
            target="_blank"
            rel="noopener noreferrer"
          >
            ⚔️ Fight
          </a>
        </nav>
      </div>
    </header>
  );
}
