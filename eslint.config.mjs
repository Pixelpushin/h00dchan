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
    // Self-contained Next.js app (own package.json/tsconfig/eslint config,
    // future separate Vercel project) - root `npm run lint` lints the CWD
    // recursively and would otherwise sweep this directory too.
    "breeding-app/**",
  ]),
]);

export default eslintConfig;
