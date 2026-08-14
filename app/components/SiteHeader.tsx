import Link from "next/link";

// Static, server-rendered header band shared by every page - "h00dchan" is
// the only site identity used here (no 4chan name, logo, or affiliation
// claim anywhere in this app).
export function SiteHeader() {
  return (
    <header className="hc-header-band">
      <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-2">
        <div>
          <Link href="/" className="hc-wordmark leading-none">
            h00dchan
          </Link>
          <p className="hc-tagline mt-0.5">
            the anonymous imageboard for HOODCHAN holders
          </p>
        </div>
        <nav className="hc-nav flex gap-4 pb-1">
          <Link href="/">connect / claim</Link>
          <Link href="/board">board</Link>
        </nav>
      </div>
    </header>
  );
}
