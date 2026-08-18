import Link from "next/link";
import { WalletHeaderWidget } from "@/app/components/WalletHeaderWidget";

// Static, server-rendered header band shared by every page - "h00dchan" is
// the only site identity used here (no 4chan name, logo, or affiliation
// claim anywhere in this app). WalletHeaderWidget is the one client island
// in here: wallet connect belongs top-right of the nav, same place every
// other dApp puts it, and needs to be reachable from any page - not just
// buried in the home page's body, and not re-implemented per page.
export function SiteHeader() {
  return (
    <header className="hc-header-band">
      <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-2">
        <div>
          <Link href="/" className="hc-wordmark leading-none">
            h00dchan
          </Link>
          <p className="hc-tagline mt-0.5">
            the anonymous message board for HOODCHAN holders
          </p>
        </div>
        <nav className="hc-nav flex items-center gap-4 pb-1">
          <Link href="/board">board</Link>
          <Link href="/alpha">alpha</Link>
          <Link href="/leaderboard">leaderboard</Link>
          <a
            href="https://www.hoodchan.website/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Artist page
          </a>
          <WalletHeaderWidget />
        </nav>
      </div>
    </header>
  );
}
