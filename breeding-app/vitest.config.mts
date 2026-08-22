import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// This app owns its own test runner (the parent h00dchan repo has none) -
// vitest was picked over jest for zero-config ESM/TS support, matching
// this repo's existing "bundler" moduleResolution/ESM-only setup without
// extra transform config. Mirrors tsconfig.json's `@/*` path alias so
// tests can import app code the same way the app itself does.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "."),
    },
  },
  test: {
    environment: "node",
    // contracts/ is a separate, self-contained Foundry project (its own
    // vendored lib/ includes openzeppelin-contracts' own Node/Hardhat test
    // suite under lib/openzeppelin-contracts/test/**) - without this
    // exclude, vitest's default glob happily picks those up too and fails
    // them all on a missing `hardhat` package, even though they have
    // nothing to do with this Next.js app's own test suite.
    exclude: ["**/node_modules/**", "contracts/**"],
  },
});
