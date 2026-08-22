# HOODCHAN Breeding Contracts

Self-contained Foundry project for the HOODCHAN breeding system across
three symmetric collections. See
`docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md` (repo
root) for the full v2 design spec, which this package is a from-scratch
rewrite against. **Status: deploy-READY, NOT deployed** - `forge build`
and `forge test` both pass; `script/Deploy.s.sol` has never been run with
`--broadcast` against any RPC.

This directory is independent of the parent h00dchan Next.js app - its own
`foundry.toml`, its own `lib/`, and it does not participate in
`next build`/`npm run lint`.

> **Supersession notice.** This is a full rewrite of an earlier attempt
> that was blocked by adversarial review. Deleted, not reintroduced: the
> two-step commit/reveal escrow-then-later-finalize scheme (and its
> lock/expiry machinery), the ETH payment path (`PayMethod`,
> `pendingEthWithdrawals`, `claimEth`), mint-into-TBA / nested-offspring
> ownership (`NESTED_CAP`, `MAX_NESTED_OFFSPRING`), and numeric-magnitude
> ("higher index always wins") dominance genetics.

## Dependencies (`lib/`)

`lib/forge-std` (1.16.2) and `lib/openzeppelin-contracts` (5.7.0) are
**vendored and committed** here, not gitignored. This is a deliberate
choice over the more common "gitignore `lib/`, restore via `forge
install`" pattern: a `forge install` restore depends on network access to
GitHub at build/CI time, and this package's own review history includes a
prior salvage effort specifically because a worktree/build state got lost
- committing the exact pinned dependency source removes that failure mode
entirely. A fresh `git clone` of this repo is buildable with just `forge
build`, no extra restore step, no network dependency.

If you'd rather not carry the vendored copy in your own fork/branch,
`forge install foundry-rs/forge-std@v1.16.2` and `forge install
OpenZeppelin/openzeppelin-contracts@v5.7.0` reproduce the identical pinned
versions - either approach works, this repo just doesn't require it.

## Contracts (`src/`)

- `GeneticsLib.sol` - per-locus genetic inheritance over the 5-slot flat
  genome (Hat, Face, Body, Background, Accessory). Standard branch is a
  **50/50 coin flip** between the literal matron and sire trait values per
  slot - band-agnostic, not numeric-magnitude dominance. Layered on top: a
  small mutation chance (5%) and a smaller legendary chance (0.5%), both
  clamped into a reserved on-chain index band (`248..255`,
  `LEGENDARY_RESERVED_START`/`LEGENDARY_BAND_SIZE`) so a rolled
  mutation/legendary value can never collide with or overflow a slot's
  real trait range. One further independent coin flip resolves a newly
  minted baby's own sex tag.
- `HoodchanGirlfriends.sol` - dummy ~12-token collection, owner mints with
  an explicit gene array and an explicit sex tag. Swap the deployed
  address in `BreedingController`'s constructor once a real collection
  ships; it only needs to satisfy `ownerOf`/`genesOf`.
- `HoodchanBabies.sol` - mint-on-breed-only offspring collection, gated to
  whatever address is set as `breedingController`. Mints via `_safeMint`
  behind `BreedingController`'s `nonReentrant` guard on `breed()` - an
  explicit choice (see Hygiene below), not an oversight. Its `genesOf`
  getter is the same name/shape as `HoodchanGirlfriends.genesOf` (the v1
  contract's `genomeOf` name is retired) so both satisfy one shared
  interface with no special-casing in `BreedingController`.
- `BreedingController.sol` - the whole breeding loop in one contract: a
  `mapping(address => bool) isBreedableCollection` allowlist covering all
  three collections, per-token escalating cooldowns, the siring-listing +
  fee-split logic, and `breed()` itself. Read its header comment first -
  it documents the HOODCHAN adapter trust point and the accepted
  breed-sniping tradeoff in full.

## Collections and the breedable allowlist

All three collections are symmetric participants - any allowlisted token
from any allowlisted collection can be matron OR sire in a given `breed()`
call, Babies included (third-generation-and-beyond breeding is in scope by
construction, not gated separately). Each allowlisted collection must
expose `ownerOf(uint256)` and `genesOf(uint256) returns (uint8[5])` in the
same shape. HOODCHAN itself is the one exception: its genes aren't
readable on-chain (off-chain ipfs:// metadata), so they're fronted by the
controller's own `hoodchanGenes` mapping, synced by an off-chain operator
script (`breeding-app/scripts/sync-genes.ts` +
`setHoodchanGenes`/`setHoodchanGenesBatch`) instead of read live -
`hoodchanGenes`/`hoodchanGenesSet` are a documented trust point. HOODCHAN's
`ownerOf`, by contrast, IS read live like any other allowlisted
collection.

Allowlist admin (`setBreedableCollection`) is `onlyOwner` - the same
multisig/ownership-guard pattern as the rest of this repo's admin actions.
A compromised single key adding a malicious contract here is a real risk,
since arbitrary `genesOf` return values feed directly into minted genomes.

## Ownership rule

Adopted directly from real CryptoKitties behavior:

- The caller must own (or be approved for) the **matron** token for that
  specific call - the only ownership check `breed()` needs.
- The **sire** can be a token the caller also owns/is approved for, or one
  someone else has explicitly listed as publicly available for siring
  (`SiringListing.listed`) - `listed == false` (the default) means "not
  available," and a `lister != ownerOf(sireId)` mismatch (i.e. the token
  changed hands since it was listed) makes a stale listing unusable, so a
  listing never silently survives a transfer.
- The baby **always mints to the matron owner's own wallet** - never a
  TBA, never the sire owner. That single rule is the whole "no stealing
  someone else's breeding output" guard; no separate consent flow is
  needed on the matron side beyond the `ownerOf` check above.

## Escalating per-token cooldown (the only anti-farm throttle)

Every token that participates in a breed - as matron or sire - gets a
cooldown afterward. Each successive cooldown for that same token is
longer, in **seconds**, roughly doubling:

```text
1min, 2min, 5min, 10min, 30min, 1hr, 2hr, 4hr, 8hr, 16hr, 1day, 2day,
4day, capped at 7 days forever after
```

(`_cooldownSeconds`, keyed by a token's own `breedCount` as the index into
the ladder for its NEXT breed.) `block.timestamp` in seconds is the only
correct unit here: Robinhood Chain (id 4663) produces ~10 blocks/sec with
second-granularity, monotonic-non-decreasing timestamps, so
`block.number` can never be used for duration math on this chain - a prior
attempt's real, empirically confirmed bug. There is no hard lifetime breed
cap and no nested-offspring cap; a token that breeds a lot naturally slows
itself down via the ladder instead.

## Sex tags and the same-sex fee tier

`CollectionSex` resolves one of three ways per allowlisted collection: fixed
`Male` (HOODCHAN), fixed `Female` (Girlfriends), or `PerToken` (Babies,
read live via `IPerTokenSex.sexOf` - coin-flipped once at mint, then fixed
for that token forever). `sameSexFeeMultiplier` (owner-configurable,
`>= 1` enforced so it can never make the same-sex tier cheaper or free)
multiplies the birth fee, and only the birth fee, when `matronSex ==
sireSex`. The resulting baby's `sameSex` flag ("Test Tube Baby") is a
cosmetic badge only - it never touches `GeneticsLib`'s coin-flip odds.

## Fees (CHAN only, both paid by the breed caller)

1. **Siring fee** - applies only when borrowing a sire the caller doesn't
   own. The sire owner receives 100% of their listed price, always. On
   top of that (added, not carved out of it), the caller pays an
   **8% protocol fee on the siring-fee portion only**, split via
   `_collectSiringFee`: **5% burned** (`burnAddress`) and **3% to the
   project multisig** (`multisig`), both in exact basis points -
   `(price * 500) / 10000` and `(price * 300) / 10000`. CHAN only stays
   CHAN in-contract; any conversion to ETH happens manually/off-chain
   later, no in-contract DEX swap. Self-siring pays no siring fee and
   therefore no protocol fee.
2. **Birth fee** - charged on every breed, no exceptions, including
   self-siring. Flat, owner-configurable (`birthFee`/`setBirthFee`),
   multiplied by `sameSexFeeMultiplier` for same-sex pairings. Goes to
   `treasury`, funding the per-baby OpenAI art-gen cost. Never split or
   burned - the 5%/3% split applies only to the siring fee above.

## Breeding flow (single atomic transaction)

One `breed(matronCollection, matronId, sireCollection, sireId)` call,
`nonReentrant`:

1. Check matron ownership/approval, sire availability (owned or listed),
   both tokens' cooldowns clear, both collections allowlisted, genes
   available for both.
2. Write cooldown state for both tokens before the external CHAN
   transfers.
3. Resolve both tokens' sex tags, compute the same-sex/opposite-sex fee
   tier, collect the birth fee (always) and siring fee (if borrowing) via
   `SafeERC20.transferFrom`.
4. Compute the seed and genome (and the baby's own sex tag) via
   `GeneticsLib`, `_safeMint` the baby to the matron owner, emit `Bred`
   carrying both parents, genome, seed, and sex.
5. Off-chain: `breeding-app/app/api/breed/[txHash]/route.ts` generates art
   (~10-20s) via `breeding-app/lib/breedingImage.ts` and sets the baby's
   `tokenURI`.

No escrow. No pull-payments. No commit/reveal. No gestation/claim step.
The genome is computed and revealed in the same transaction.

### Accepted tradeoff - breed-sniping

`GeneticsLib.breedingSeed` is a pure function of public inputs only (both
parents' collection+id and a per-breed nonce) - a sophisticated caller can
simulate the outcome client-side before sending the breed tx and choose
whether to send it. **This is explicitly accepted, not mitigated** -
Brady's call: "you get what you get." No blockhash anchoring, VRF, or any
other seed-hiding mechanism is used here; the escalating cooldown plus the
unconditional birth fee are the spec's chosen bound on the damage
(re-rolling costs real CHAN and burns real cooldown time).

## Why `_safeMint`, behind `nonReentrant`, in `HoodchanBabies`

Babies now mint to an arbitrary caller-side wallet - possibly a contract -
not a known-codeless counterfactual TBA address the way the earlier
attempt did. Using plain `_mint` here would silently skip the
`onERC721Received` check for any real contract-wallet recipient, an
explicit hygiene requirement from adversarial review not to leave as an
assumption. `_safeMint`'s reentrancy surface is bounded by
`BreedingController`'s own `nonReentrant` guard on `breed()`, which is
already held for the whole call at the point the mint happens - a
malicious `onERC721Received` implementation cannot re-enter `breed()` (or
any other `nonReentrant` controller function) from inside the mint.

## Commands

```shell
forge build
forge test -vv
```

`test/GenerateTestVectors.t.sol` regenerates `test-vectors.json` (checked
into git, unlike build artifacts) every time `forge test` runs - it's the
fixture the off-chain TS-parity implementation
(`breeding-app/lib/breedingGenetics.parity.test.ts`) is checked against.

`test/GenerateFreshTestVectors.t.sol` / `test-vectors-fresh.json` is a
second, independent fixture generator using a deliberately different
token-ID range, gene formula, and entropy salt than the primary one - a
staleness/overfitting guard so a TS port that was hardcoded against the
primary fixture's specific numbers (rather than genuinely re-implementing
`GeneticsLib`'s arithmetic) still gets caught.

`test/Adversarial.t.sol` covers the specific bug classes adversarial
review flagged directly: siring-fee front-running/slippage, stale-listing
survival across a transfer, and same-sex-multiplier floor enforcement.

## Deployment

`script/Deploy.s.sol` is written and ready but has **never been run with
`--broadcast`**, and this task does not run it that way either - dry-run
(`forge script` without `--broadcast`) only, to sanity-check it compiles
and simulates. Read its header comment for the full prerequisite list
before ever pointing it at a real RPC:

1. A funded Pixelpushin deployer key on Robinhood Chain (id 4663),
   imported via `cast wallet import` into a Foundry keystore - **not** an
   env var private key.
2. `DEPLOYER_ADDRESS` env var set to that key's address.
3. Deploy order (enforced by the script): `HoodchanGirlfriends` and
   `HoodchanBabies` first, then `BreedingController`, then
   `babies.setBreedingController(controller)`.
4. **After** deploy: run `breeding-app/scripts/sync-genes.ts` (not part of
   this Foundry package) to populate `hoodchanGenes` for every live
   HOODCHAN token before any `breed()` call can use one as a parent - the
   collection is unusable for breeding until that sync runs
   (`GenesNotSet`).

**This task never broadcasts to any live chain** - no RPC was ever pointed
at with `--broadcast`, on Robinhood Chain or anywhere else.
