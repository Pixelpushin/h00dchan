import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @reown/appkit-adapter-ethers pulls in Coinbase Smart Wallet support
  // (@base-org/account -> @coinbase/cdp-sdk) for its x402 payment feature.
  // That feature is unused here (we only need address + personal_sign),
  // but cdp-sdk's dynamic import()s of its optional @x402/* peer deps
  // (never installed - they're marked optional in cdp-sdk's own
  // package.json) get statically resolved during SSR bundling of
  // app/page.tsx otherwise, which 500s the page outright. Marking these
  // external skips bundling them for the server and lets Node's own
  // resolution (which tolerates a rejected optional dynamic import) handle
  // it instead - confirmed to fix the 500 by testing locally.
  serverExternalPackages: ["@coinbase/cdp-sdk", "@base-org/account"],
};

export default nextConfig;
