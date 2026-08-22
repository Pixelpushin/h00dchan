import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Self-contained Foundry project (own forge/solidity tooling, vendored
    // lib/ includes openzeppelin-contracts' own JS/Hardhat test suite) -
    // see contracts/README.md. Not part of this app's lint.
    "contracts/**",
  ]),
]);

export default eslintConfig;
