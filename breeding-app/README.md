# HOODCHAN Breeding App

Self-contained Next.js app (own `package.json`/`tsconfig.json`/`next.config.ts`)
deployed as its own separate Vercel project - root directory `breeding-app/`,
domain `fuck.hoodchan.org`. Not part of the parent h00dchan app's build/lint
(see the root `tsconfig.json` `exclude` and `eslint.config.mjs`
`globalIgnores` entries for this directory).

See `contracts/README.md` for the Foundry contracts subproject, and
`docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md` (repo root)
for the full design spec.

## ABIs (`lib/abi/`)

`lib/abi/*.ts` are **generated, not hand-written**. Every on-chain read/tx
builder in `lib/breedingController.ts` and `lib/babies.ts` imports its ABI
from here - never an inline/hand-written ABI array. An earlier attempt at
this app hand-wrote ABIs from guessed function names
(`breedWithChan`/`breedWithEth`, `setSirePrice`, an invented
`allListedTokenIds()` enumerator, `parentsOf`/`seedOf` getters that don't
exist) that didn't match the real deployed contracts. Generating straight
from `forge build`'s own output makes that class of bug structurally
impossible.

To regenerate after any `contracts/src/*.sol` change:

```shell
cd contracts && forge build && cd ..
npm run copy-abis
```

`scripts/copy-abis.ts` reads `contracts/out/**/*.json` (gitignored, local
build output) and writes the extracted `abi` array into a typed TS module
per contract in `lib/abi/`. Never source an ABI from anywhere else.
