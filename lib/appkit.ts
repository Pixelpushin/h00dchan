// Reown AppKit (formerly WalletConnect) client-side singleton. Adds real
// mobile/QR wallet support (WalletConnect) on top of continued support for
// injected browser extensions - AppKit's own connect modal handles both
// through one unified flow, so callers no longer need to branch on
// "is there a window.ethereum".
//
// Ethers adapter, not wagmi/viem: `ethers` is already a dependency of this
// repo (lib/auth-server.ts uses it server-side for `verifyMessage`), and
// wagmi+viem would be a second, redundant web3 stack for the same job.
// (viem itself still ends up in node_modules transitively - AppKit's own
// network typing (`defineChain`) is built on viem's `Chain` type - but it's
// never imported at runtime here, only used for type-checking this file.)
//
// Robinhood Chain (id 4663) is not a preset in AppKit's/viem's default
// chain list, so it's defined here as a custom CaipNetwork, using the exact
// values already verified and used elsewhere in this repo (lib/wallet.ts's
// ROBINHOOD_CHAIN, lib/chain.ts's RPC_URL/CHAIN_ID_HEX/CONTRACT).
"use client";

import { createAppKit, type AppKit } from "@reown/appkit";
import { defineChain } from "@reown/appkit/networks";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";

export const robinhoodChain = defineChain({
  id: 4663,
  caipNetworkId: "eip155:4663",
  chainNamespace: "eip155",
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

let appKit: AppKit | undefined;

// Lazily created, module-scoped singleton - AppKit must only be
// initialized once per page load (it injects a global `<appkit-modal>` web
// component), and it must never be constructed during SSR (it touches
// `window`), so this is only ever called from client code paths
// (lib/wallet.ts's functions, all of which already run client-side only).
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
        name: "h00dchan",
        description: "The anonymous imageboard for HOODCHAN NFT holders.",
        url:
          typeof window !== "undefined"
            ? window.location.origin
            : "https://h00dchan.xyz",
        icons: [],
      },
      features: {
        analytics: false,
        // Extension + WalletConnect(QR/mobile) only - no email/social login,
        // no swaps/on-ramp widgets. This app just needs an address + a
        // personal_sign, not a full wallet-as-a-service surface.
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
