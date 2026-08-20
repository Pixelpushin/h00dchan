import Link from "next/link";
import { WalletHeaderWidget } from "@/app/components/WalletHeaderWidget";

// Static, server-rendered header band shared by every page - "h00dchan" is
// the only site identity used here (no 4chan name, logo, or affiliation
// claim anywhere in this app).
//
// Two separate rows, not one wrapping flex group: the wallet widget used
// to sit as the LAST item inside the same wrapping <nav> as the text
// links, which meant once the links wrapped to their own line (adding
// "collection" pushed this over the edge at common widths), the wallet
// button wrapped right along with them instead of staying anchored
// top-right of the page - not where every other site (OpenSea, Google,
// GitHub) puts the account button, and reported live as genuinely
// confusing/messy. Top row (logo vs. wallet widget) never wraps together
// now; the nav links get their own row below and can wrap freely on
// their own without ever moving the wallet button.
export function SiteHeader() {
  return (
    <header className="hc-header-band">
      <div className="mx-auto flex max-w-5xl flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <div>
            <Link href="/" className="hc-wordmark leading-none">
              h00dchan
            </Link>
            <p className="hc-tagline mt-0.5">
              the anonymous message board for HOODCHAN holders
            </p>
          </div>
          <WalletHeaderWidget />
        </div>
        <nav className="hc-nav flex flex-wrap items-center gap-2 sm:gap-4 pb-1">
          <Link href="/board">board</Link>
          <Link href="/collection">collection</Link>
          <Link href="/wallet">wallet</Link>
          <Link href="/alpha">alpha</Link>
          <Link href="/CircleJerkFinance">circlejerkfinance</Link>
          <Link href="/leaderboard">leaderboard</Link>
          <Link href="/developers">developers</Link>
          <a
            href="https://www.hoodchan.website/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Artist page
          </a>
          <a
            href="https://fight.hoodchan.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="hc-nav-fight"
          >
            ⚔️ Fight
          </a>
        </nav>
      </div>
    </header>
  );
}
