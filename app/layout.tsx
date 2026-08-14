import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteHeader } from "@/app/components/SiteHeader";
import { ClankerProgress } from "@/app/components/ClankerProgress";
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
  description: "The anonymous imageboard for HOODCHAN NFT holders.",
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
        {children}
      </body>
    </html>
  );
}
