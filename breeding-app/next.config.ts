import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pins Turbopack's workspace root to this directory instead of letting it
  // walk up and find the parent h00dchan repo's own package-lock.json. This
  // app is deployed as a separate Vercel project with root directory =
  // breeding-app/, so on Vercel there's no parent lockfile to find - but
  // locally (this app lives inside the h00dchan git repo, one directory
  // below its own lockfile) Turbopack otherwise warns about "multiple
  // lockfiles" and guesses wrong. Pinning it here keeps local dev/build
  // output identical to what Vercel will actually do.
  turbopack: {
    root: path.join(__dirname),
  },
  // Same fix as the parent h00dchan repo's next.config.ts (copied here
  // because this app is a separate Vercel project and can't import that
  // file): @reown/appkit-adapter-ethers pulls in Coinbase Smart Wallet
  // support (@base-org/account -> @coinbase/cdp-sdk) for its x402 payment
  // feature, unused here (we only need address + personal_sign). cdp-sdk's
  // dynamic import()s of its optional @x402/* peer deps (never installed -
  // marked optional in cdp-sdk's own package.json) get statically resolved
  // during SSR bundling otherwise, which 500s the page. Marking these
  // external skips server bundling and lets Node's own resolution (which
  // tolerates a rejected optional dynamic import) handle it instead.
  serverExternalPackages: ["@coinbase/cdp-sdk", "@base-org/account"],
};

export default nextConfig;
