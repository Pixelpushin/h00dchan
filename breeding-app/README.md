# HOODCHAN Breeding App

Self-contained Next.js app (own `package.json`/`tsconfig.json`/`next.config.ts`)
deployed as its own separate Vercel project - root directory `breeding-app/`,
domain `fuck.hoodchan.org`. Not part of the parent h00dchan app's build/lint
(see the root `tsconfig.json` `exclude` and `eslint.config.mjs`
`globalIgnores` entries for this directory).

See `contracts/README.md` for the Foundry contracts subproject, and
`docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md` (repo root)
for the full v2 design spec, which this app is built against. **Status:
deploy-READY, NOT deployed** - contracts compile and pass a full test
suite, but `contracts/script/Deploy.s.sol` has never been run with
`--broadcast` on any chain.

## v2 in one paragraph

CryptoKitties-style breeding across three symmetric ERC-721 collections
(HOODCHAN, HoodchanGirlfriends, HoodchanBabies) - any allowlisted token from
any allowlisted collection can be matron OR sire, babies included. One
`breed(matronCollection, matronId, sireCollection, sireId)` call does
everything in a single atomic transaction: ownership/availability checks,
cooldown writes, CHAN fee collection, genome computation (50/50 coin flip
per gene slot, plus small mutation/legendary chances), and mint straight to
the matron owner's own wallet. No commit/reveal, no escrow, no TBA minting,
no ETH path - all deleted from the earlier attempt, not carried forward.

## Fees (CHAN only, both components paid by the breed caller)

1. **Birth fee** - charged on every breed, no exceptions, including
   breeding two of your own tokens. Owner-configurable flat amount, doubled
   as a "same-sex"/"test tube baby" multiplier when both parents share a
   sex tag (still just multiplying the birth fee - never the siring fee).
   Funds the per-baby OpenAI art-generation cost; not split or burned.
2. **Siring fee** - only when the sire is NOT owned by the caller and its
   owner has explicitly opted it in for public siring (a zero-price listing
   is still an explicit listing, never an implicit default). The sire's
   owner receives 100% of their listed price. On top of that, the caller
   additionally pays an **8% protocol fee on the siring-fee portion only**:
   **5% burned**, **3% to the project multisig** (held in CHAN; any
   ETH conversion happens manually/off-chain later, no in-contract DEX
   swap). Self-siring (breeder owns both matron and sire) pays birth fee
   only - no siring fee, no protocol fee.

## Cooldown (the only anti-farm throttle)

Every token that breeds - as matron or sire - gets a per-token cooldown
that escalates with each use, roughly doubling: 1min, 2min, 5min, 10min,
30min, 1hr, 2hr, 4hr, 8hr, 16hr, 1day, 2day, 4day, capped at 7 days. All
math is in **seconds off `block.timestamp`** - Robinhood Chain (id 4663)
produces ~10 blocks/sec, so `block.number` can never be used for duration
math there (a prior attempt's real bug). No lifetime breed cap and no
nested-offspring cap exist anymore; a token that breeds a lot naturally
slows itself down instead.

## Sex tags + Test Tube Baby

Every token carries a `Male`/`Female` sex tag - fixed (`Male` for HOODCHAN,
`Female` for Girlfriends) or, for Babies, an independent 50/50 coin flip at
mint time that then carries forward if that baby later breeds. Same-sex
pairings pay the birth-fee multiplier above and the resulting baby carries
a visible "Test Tube Baby" badge - a cosmetic flex trait only, it does not
touch coin-flip inheritance odds at all.

## ABIs (`lib/abi/`)

`lib/abi/*.ts` are **generated, not hand-written**. Every on-chain read/tx
builder in `lib/breedingController.ts` and `lib/babies.ts` imports its ABI
from here - never an inline/hand-written ABI array. An earlier attempt at
this app hand-wrote ABIs from guessed function names that didn't match the
real deployed contracts. Generating straight from `forge build`'s own
output makes that class of bug structurally impossible.

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
`BreedingController.breed()` reverts `GenesNotSet()` for every real
HOODCHAN parent - HOODCHAN's genes aren't readable on-chain (its
`tokenURI` resolves to off-chain ipfs:// metadata), so they're synced in by
an off-chain operator script instead of read live. `hoodchanGenes` /
`hoodchanGenesSet` are a documented trust point: a stale or malicious sync
would let a HOODCHAN parent breed with wrong genes, and there's no on-chain
way to catch that.

### The registry's index space in v2

`lib/traitRegistry.ts`'s trait-string -> `uint8` index mapping is still the
canonical registry, and its 6-category -> 5-slot collapse is unchanged
(Hats->hat, Faces->face, Bodies->body, Backgrounds->background,
Extra/"Girl Stuff"->accessory; Grillz/Grills stay cosmetic-only, dropped
from the genome). What changed in v2: the registry's **ascending-rarity
ordering is no longer load-bearing for inheritance** - `GeneticsLib`'s
standard branch is now a 50/50 coin flip between the literal matron and
sire values, not "numerically higher index wins," so which index a common
vs. rare trait gets doesn't advantage it genetically anymore. The
ordering's one remaining load-bearing job is the **reserved index band**:
indices `248..255` (`LEGENDARY_RESERVED_START`) are set aside per slot for
mutation/legendary rolls so they can never collide with, or overflow past,
a slot's real trait range.

| Slot | HOODCHAN key | Girlfriend key |
|---|---|---|
| `hat` | `Hats` | `Hats` |
| `face` | `Faces` | `Faces` |
| `body` | `Bodies` | `Bodies` |
| `background` | `Backgrounds` | `Backgrounds` |
| `accessory` | `Extra` | `Girl Stuff` |
| *(cosmetic, non-genetic)* | `Grillz` | `Grills` |

The registry file is **generated, then hand-committed** - never rebuilt
implicitly at build/import time. Bump `TRAIT_REGISTRY_VERSION` and re-run a
full sync if the index space ever needs to change; never patch a handful of
indices in place.

### Runbook

**1. Build the contracts and generate the registry's HOODCHAN frequency data** (once, or whenever re-deriving):

```shell
cd contracts && forge build && cd ..
npm run copy-abis
npx tsx scripts/build-trait-registry.ts
# -> writes data/hoodchan-trait-frequency.json (raw per-value counts)
# -> hand-transcribe the printed order into lib/traitRegistry.ts's
#    HOODCHAN_VALUE_INDEX tables (deliberately a reviewed, manual step -
#    see that file's header)
```

**2. Emit the 12 dummy Girlfriends' gene arrays** (needed before/at deploy time, for `HoodchanGirlfriends.mint(to, genes)`):

```shell
npx tsx scripts/emit-girlfriend-genes.ts
# -> writes data/girlfriend-genes.json
```

**3. After BreedingController + HoodchanGirlfriends + HoodchanBabies deploy** (`contracts/script/Deploy.s.sol`, human-approved `--broadcast` only, not yet run against any chain):

```shell
# ALWAYS dry-run first - this is the default, no flag needed:
npx tsx scripts/sync-genes.ts --start 1 --end 50 --out data/sync-report-sample.json

# Once satisfied, run the full collection dry-run:
npx tsx scripts/sync-genes.ts --out data/sync-report-full.json

# Only then, with BOTH the flag AND the explicit env consent phrase set,
# from an operator hot key registered via BreedingController's operator
# role (never the deployer/owner key):
SEND_REAL_TX=I_UNDERSTAND_THIS_SENDS_REAL_TRANSACTIONS PRIVATE_KEY=0x... \
  npx tsx scripts/sync-genes.ts --broadcast --start 1 --end 50
```

`--broadcast` is double-guarded: it requires both the flag AND
`SEND_REAL_TX` set to the exact consent phrase above. Neither this app's
`npm test`/`npm run build`/`tsc --noEmit`, nor any CI job, ever invokes
this script - it is a manual, human-run operator step only.

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
| `OPENSEA_API_KEY` | `lib/openseaToken.ts` | Optional cross-check only; sync-genes runs fine without it (tokenURI's own `STATUS` field is the primary source) |
| `OPENSEA_CHAIN_SLUG` | `lib/openseaToken.ts` | Overrides the guessed `"robinhood"` OpenSea chain slug - **not independently confirmed OpenSea indexes Robinhood Chain at all** |
| `SEND_REAL_TX` | `scripts/sync-genes.ts` | Must equal exactly `I_UNDERSTAND_THIS_SENDS_REAL_TRANSACTIONS` to broadcast |
| `PRIVATE_KEY` | `scripts/sync-genes.ts` | Operator hot key for the `--broadcast` path only - never the deployer/owner key |

## Voluntary post-breed TBA nesting (not part of the breed flow)

Babies always mint straight to the matron's owner's own wallet now - never
into a token-bound account. `lib/tba.ts` and `lib/girlfriends.ts`'s
`fetchGirlfriendsWithNestedBabies` still exist, but purely for a
display-only feature on `/my`: an owner can voluntarily move an
already-minted baby into a Girlfriend's TBA afterward, for the parent
app's existing `lib/leveling.ts` XP. There is no cap on this, and it is
never a gate on anything breeding-related.
