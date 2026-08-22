// Reown AppKit client-side singleton - self-contained copy of the parent
// h00dchan app's lib/appkit.ts (same Robinhood Chain custom network, same
// ethers adapter), not imported from it since this app deploys as its own
// separate Vercel project.
"use client";

import { createAppKit, type AppKit } from "@reown/appkit";
import { defineChain } from "@reown/appkit/networks";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { RPC_URL, BLOCK_EXPLORER_URL, CHAIN_ID } from "@/lib/config";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  caipNetworkId: `eip155:${CHAIN_ID}`,
  chainNamespace: "eip155",
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Robinhood Chain Explorer", url: BLOCK_EXPLORER_URL },
  },
});

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

let appKit: AppKit | undefined;

export function getAppKit(): AppKit {
  if (!projectId) {
    throw new Error(
      "NEXT_PUBLIC_REOWN_PROJECT_ID is not set - wallet connect is unavailable.",
    );
  }
  if (!appKit) {
    appKit = createAppKit({
      adapters: [new EthersAdapter()],
      networks: [robinhoodChain],
      defaultNetwork: robinhoodChain,
      projectId,
      metadata: {
        name: "HOODCHAN Breeding",
        description: "Sire and raise HOODCHAN x Girlfriends offspring.",
        url:
          typeof window !== "undefined"
            ? window.location.origin
            : "https://fuck.hoodchan.org",
        icons: [],
      },
      features: {
        analytics: false,
        email: false,
        socials: false,
        swaps: false,
        onramp: false,
      },
      themeMode: "dark",
    });
  }
  return appKit;
}
