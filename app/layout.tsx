import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { SiteHeader } from "@/app/components/SiteHeader";
import { ClankerProgress } from "@/app/components/ClankerProgress";
import { WhatIsHoodchan } from "@/app/components/WhatIsHoodchan";
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
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
