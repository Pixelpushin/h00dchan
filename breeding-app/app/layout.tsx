import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { SiteHeader } from "@/app/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "HOODCHAN Breeding",
  description: "Sire your anon, raise the offspring.",
};

// Every page here reads live chain state - see the parent app's own
// layout.tsx for the same reasoning (a handful of routes forgot to opt in
// individually and served stale statically-baked data).
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="hc-page min-h-full flex flex-col">
        <SiteHeader />
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
