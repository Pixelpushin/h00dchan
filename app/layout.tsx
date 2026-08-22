import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { SiteHeader } from "@/app/components/SiteHeader";
import { ClankerProgress } from "@/app/components/ClankerProgress";
import { WhatIsHoodchan } from "@/app/components/WhatIsHoodchan";
import { Trollbox } from "@/app/components/Trollbox";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "h00dchan",
  description: "The anonymous message board for HOODCHAN NFT holders.",
};

// ClankerProgress (rendered below, on every route) reads live on-chain
// totalSupply() on every request - most routes already set this
// individually, but a handful (collection, developers, onlychans, wallet
// index) didn't, so their static HTML baked in a stale count from build
// time and never updated after burns. Setting it here at the root layout
// guarantees every route re-renders it live, instead of relying on each
// new page remembering to opt in.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="hc-page min-h-full flex flex-col">
        <SiteHeader />
        <ClankerProgress />
        <WhatIsHoodchan />
        {children}
        <Trollbox />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
