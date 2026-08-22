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

## Gene registry + HOODCHAN metadata sync (`lib/traitRegistry.ts` / `scripts/sync-genes.ts`)

This is the piece every prior attempt at breeding skipped. Without it,
`BreedingController.breed()`/`commitBreed()` revert `GenesNotSet()` for
**every** real HOODCHAN father - `contracts/script/Deploy.s.sol`'s own
header literally says the sync script "is not yet written". The two files
below are that missing piece.

### Why the registry's numbering is genetics, not just a lookup table

`GeneticsLib.sol`'s standard-inheritance branch (94.5% of breeds,
`GeneticsLib.sol:106-108`) is:

```solidity
uint8 dominant = p1 > p2 ? p1 : p2;
uint8 recessive = p1 <= p2 ? p1 : p2;
return (draw < DOMINANT_INHERITANCE_RATE) ? dominant : recessive;
```

"Dominant" means **numerically higher**, full stop - there is no separate
dominance table anywhere on-chain. The raw `uint8` index assigned to a
trait string in `lib/traitRegistry.ts` **is** its genetic dominance rank.
That makes the registry's ordering a real game-design decision, not an
implementation detail:

- **Common trait value -> low index -> usually recessive.**
- **Rare trait value -> high index -> usually dominant.**
- Ordering comes from real, live HOODCHAN trait-value frequency
  (`scripts/build-trait-registry.ts`, same fetch-all-1200 +
  chunked-concurrency + exponential-backoff shape as the parent h00dchan
  app's `scripts/compute-rarity.ts`), not a guess.
- The registry file is **generated, then hand-committed** - never rebuilt
  implicitly at build/import time. **Reordering an index after
  `setHoodchanGenesBatch` has already been run against real fathers
  silently corrupts their on-chain genetic dominance** - already-synced
  tokens don't get re-synced automatically, so there's no on-chain signal
  that a reorder happened. Bump `TRAIT_REGISTRY_VERSION` and re-run a full
  sync if this ever needs to change; never patch a handful of indices in
  place.

### The 6-category -> 5-slot collapse

HOODCHAN's live metadata has six `trait_type` keys (Backgrounds, Bodies,
Faces, Hats, Extra, Grillz, plus a non-genetic `STATUS`); Girlfriend
metadata also has six (Backgrounds, Bodies, Faces, Hats, Girl Stuff,
Grills). `BreedingController`'s genome is flat 5-slot
(Hat/Face/Body/Background/Accessory). Collapse rule (see
`lib/traitRegistry.ts`'s header for the full reasoning):

| Slot | HOODCHAN key | Girlfriend key |
|---|---|---|
| `hat` | `Hats` | `Hats` |
| `face` | `Faces` | `Faces` |
| `body` | `Bodies` | `Bodies` |
| `background` | `Backgrounds` | `Backgrounds` |
| `accessory` | `Extra` | `Girl Stuff` |
| *(cosmetic, non-genetic)* | `Grillz` | `Grills` |

`Extra`/`Girl Stuff` fold into one shared `accessory` slot (each
collection's own "5th flavor category"); `Grillz`/`Grills` are dropped
from the genome entirely on **both** sides and only recorded for
display (`sync-genes.ts` logs it per father; `girlfriend-genes.json`
carries it in a separate `cosmetic` field).

This was **verified live**, not spec-asserted: an earlier design-spec draft
claimed a live sample "saw only Backgrounds/Bodies/Faces/Hats on ordinary
tokens" and that `STATUS: "Upgraded"` was OpenSea-only. Re-checked
2026-08-22 directly against `tokenURI`:

```text
curl https://hoodchan-metadata-service.vercel.app/metadata/700
  -> Backgrounds/Bodies/Faces/Hats/Extra (ordinary, non-Upgraded token - Extra IS present)
curl https://hoodchan-metadata-service.vercel.app/metadata/531
  -> {"trait_type":"STATUS","value":"Upgraded"} present directly in the tokenURI JSON
```

So `Extra` is a real (if inconsistently populated) ordinary category, and
`STATUS` is readable straight off the same `tokenURI` fetch already being
made for gene mapping - no extra OpenSea call is *required* to detect
Upgraded status, though `lib/openseaToken.ts`'s per-token OpenSea API call
still exists as an optional `--check-opensea` cross-check (see that file's
header for why: metadata services can drift, and it's a genuine second
signal for a token whose tokenURI happens to be stale at sync time).

### Runbook

**1. Build the contracts and generate the registry's HOODCHAN frequency data** (once, or whenever re-deriving):

```shell
cd contracts && forge build && cd ..
npm run copy-abis
npx tsx scripts/build-trait-registry.ts
# -> writes data/hoodchan-trait-frequency.json (raw per-value counts)
# -> hand-transcribe the printed ascending-frequency order into
#    lib/traitRegistry.ts's HOODCHAN_VALUE_INDEX tables (deliberately a
#    reviewed, manual step - see that file's header)
```

**2. Emit the 12 dummy Girlfriends' gene arrays** (needed before/at deploy time, for `HoodchanGirlfriends.mint(to, genes)`):

```shell
npx tsx scripts/emit-girlfriend-genes.ts
# -> writes data/girlfriend-genes.json
```

**3. After BreedingController + HoodchanGirlfriends + HoodchanBabies deploy** (`contracts/script/Deploy.s.sol`, human-approved `--broadcast` only):

```shell
# ALWAYS dry-run first - this is the default, no flag needed:
npx tsx scripts/sync-genes.ts --start 1 --end 50 --out data/sync-report-sample.json

# Once satisfied, run the full collection dry-run:
npx tsx scripts/sync-genes.ts --out data/sync-report-full.json

# Only then, with BOTH the flag AND the explicit env consent phrase set,
# from an operator hot key registered via BreedingController.setOperator
# (never the deployer/owner key):
SEND_REAL_TX=I_UNDERSTAND_THIS_SENDS_REAL_TRANSACTIONS PRIVATE_KEY=0x... \
  npx tsx scripts/sync-genes.ts --broadcast --start 1 --end 50
```

**4. After a future real Girlfriends collection swap** (per the design
spec - the dummy `HoodchanGirlfriends` above is explicitly throwaway):
re-run `scripts/emit-girlfriend-genes.ts` against the new collection's own
metadata source before minting anything against `TRAIT_REGISTRY_VERSION`'s
existing indices - the registry's *value space* carries over (a shared
trait string still maps to the same index), but any brand-new trait
strings the real team's art introduces need to be appended above the
current max index for each slot, never inserted in the middle.

### Env vars

| Var | Used by | Required for |
|---|---|---|
| `ALCHEMY_API_KEY` | `lib/config.ts` (`DEFAULT_RPC_URL`) | Reliable RPC reads at scale - the plain public Robinhood Chain RPC is documented elsewhere in this ecosystem as unreliable under real load |
| `OPENSEA_API_KEY` | `lib/openseaToken.ts` | Only needed for `--check-opensea`; sync-genes runs fine without it (tokenURI's own `STATUS` field is the primary source) |
| `OPENSEA_CHAIN_SLUG` | `lib/openseaToken.ts` | Overrides the guessed `"robinhood"` OpenSea chain slug - **not independently confirmed OpenSea indexes Robinhood Chain at all** |
| `SEND_REAL_TX` | `scripts/sync-genes.ts` | Must equal exactly `I_UNDERSTAND_THIS_SENDS_REAL_TRANSACTIONS` to broadcast |
| `PRIVATE_KEY` | `scripts/sync-genes.ts` | Operator hot key for the `--broadcast` path only - never the deployer/owner key |
