# HOODCHAN Breeding Contracts

Self-contained Foundry project for the HOODCHAN x HoodchanGirlfriends
breeding system. See
`docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md` (repo
root) for the full design spec.

This directory is independent of the parent h00dchan Next.js app - its own
`foundry.toml`, its own `lib/`, and it does not participate in
`next build`/`npm run lint`.

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

- `GeneticsLib.sol` - bit-for-bit port of AquaPrime's per-locus genetic
  inheritance algorithm (`AquaPrimeGenetics.sol` in AQUAPRIME_RPG), scoped
  to a 5-slot flat genome (Hat, Face, Body, Background, Accessory).
  `breedingSeed` takes an explicit 4th `entropy` parameter (see "Seed
  fairness" below).
- `HoodchanGirlfriends.sol` - dummy ~12-token "mother" collection, owner
  mints with an explicit gene array. Swap the deployed address in
  `BreedingController`'s constructor once a real collection ships.
- `HoodchanBabies.sol` - offspring collection, mint-on-breed only (gated
  to whatever address is set as `breedingController`). Mints via `_mint`,
  not `_safeMint` - see that function's doc comment and "Seed fairness"
  below.
- `BreedingController.sol` - the P2P siring economy: HOODCHAN owner sets a
  price, Girlfriend owner commits then reveals a breed, baby mints
  directly into the mother's ERC-6551 token-bound account. Read its
  header comment first - it documents the off-chain metadata-sync trust
  points and the commit/reveal seed-fairness mitigation in full.

## Seed fairness: commit/reveal + blockhash entropy

An earlier single-transaction `breed()` design computed its seed as
`keccak256(fatherTokenId, motherTokenId, breedNonce)` - every input was
either already public (token IDs) or readable from the contract before a
given tx landed (`breedNonce`, a public sequential counter). That made
the resulting genome, including whether a legendary mutation hits, fully
computable in advance ("breed-sniping"): a caller could preview the
outcome and choose to send or withhold their tx based on it.

This is fixed with a **commit/reveal** split:

1. **`commitBreed(fatherTokenId, motherTokenId, maxChanPrice,
   maxEthPrice, method)`** - verifies ownership, that the father's genes
   are synced, and the mother's 5-baby nested cap; escrows payment at the
   **current** listed price (bounded by the caller's `maxChanPrice`/
   `maxEthPrice` - see "Slippage guard" below, never overpaying past what
   the caller agreed to); locks both parent tokens against any other
   concurrent commit; and snapshots `commitBlock = block.number` plus a
   fresh `breedNonce`.
2. **`revealBreed(commitId)`** - callable by **anyone**, once
   `block.number > commitBlock`. Derives the seed as
   `keccak256(fatherTokenId, motherTokenId, nonce,
   blockhash(commitBlock))`. `blockhash(commitBlock)` is the hash of a
   block that did not exist yet when the commit tx was sent - it cannot be
   known or precomputed at commit time, which is what closes the
   pre-computation window above.

**Why `blockhash`, not `block.prevrandao`:** the deploy target is
Robinhood Chain (chain id 4663), a Nitro-based Arbitrum Orbit chain. On
Orbit/Arbitrum chains, `block.prevrandao` is not derived from L1
post-Merge randomness the way it is on Ethereum mainnet - it's
attacker-influenceable/known ahead of time there, so using it would
silently reintroduce the exact bug this mitigation exists to close.
`blockhash(n)` for a past block `n`, by contrast, behaves normally on
Nitro-based Orbit chains for the most recent 256 L2 blocks (same window as
Ethereum L1) and is genuinely unknown until block `n` is produced.

**Known residual limitations (accepted for v1, both documented on
`BreedingController` directly too):**

- A block producer with control over whether `commitBlock` gets built at
  all has a much narrower grinding window than full seed pre-computation
  - a limitation shared by essentially every blockhash-based commit/reveal
    scheme, not unique to this one. No VRF/oracle (e.g. Pyth VRF, as
    AquaPrime's own genetics system uses) is introduced here; the design
    spec explicitly prioritizes shipping the P2P economy without an
    oracle dependency for v1.
- If `revealBreed` isn't called within 256 blocks of `commitBlock`,
  `blockhash(commitBlock)` returns `0` and the reveal can no longer be
  fairly computed. `revealBreed` reverts with `CommitExpired` in that
  case; `cancelExpiredCommit(commitId)` refunds the escrowed payment (via
  the same pull-claim path as a normal payout - see below) and unlocks
  both parent tokens. A "re-anchor to `blockhash(block.number - 1)`"
  fallback (trading a smaller grinding window for not having to retry) was
  considered and deliberately **not** implemented - expire-and-refund is
  simpler and strictly safer.

## Slippage guard (`maxChanPrice` / `maxEthPrice`)

`commitBreed` takes caller-supplied `maxChanPrice`/`maxEthPrice` bounds
and reverts with `PriceExceedsMax` *before any transfer* if the father's
**current** listed price exceeds them. This closes a front-running vector
where a father owner could raise `setSiringPrice` between when a caller
decided what to pay and when their tx landed - the contract always
escrows the current listed price, never the caller's max.

## Payout ordering (pull payments, mint-before-payout)

`revealBreed` mints the baby into the mother's TBA **before** paying the
father owner anything. ETH payouts are always **pull-based** (credited to
`pendingEthWithdrawals`, claimed via `claimEth()`) - there is no `.call`
to an external address anywhere in `revealBreed`, so a hostile father
owner's `receive()` hook can never run (and therefore can never revert or
otherwise interfere) during reveal. CHAN payouts attempt a direct push
first (a plain ERC-20 `transfer` has no recipient callback to exploit)
and fall back to `pendingChanWithdrawals` (claimed via `claimChan()`) if
that push fails for any reason. Net effect: no payout code path can ever
un-mint, block, or influence an already-computed genome.

## Why `_mint`, not `_safeMint`, in `HoodchanBabies`

Every baby mints directly into the mother's **computed** ERC-6551 TBA
address (`tbaRegistry.account(...)`), which has **no code** on Robinhood
Chain until the tba-kit implementation
(`0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`) is actually deployed there
- confirmed not yet deployed as of this writing. `_safeMint`'s
`onERC721Received` check is a no-op today (skipped entirely for a
codeless recipient), so behaviorally `_mint` and `_safeMint` are
identical right now - but `_mint` removes the dependency on that staying
true forever. Once the TBA implementation *is* deployed, `_safeMint` would
start invoking it mid-mint, handing control away during
`BreedingController.revealBreed` at exactly the moment the genome is
being finalized. `_mint` never does this.

**Practical consequence:** minting to the counterfactual TBA address works
today regardless of whether the TBA implementation is deployed. What does
**not** work yet is calling `execute()` *from* a baby's (or the mother's)
TBA - that requires the implementation contract to actually be live on
Robinhood Chain. Nothing in this package needs that to build, test, or
mint; it only matters for downstream product flows that expect to
interact *as* a TBA.

## Commands

```shell
forge build
forge test -vv
```

`test/GenerateTestVectors.t.sol` regenerates `test-vectors.json` (checked
into git, unlike build artifacts) every time `forge test` runs - it's the
fixture the off-chain TS-parity implementation is checked against. It
uses the final 4-arg `GeneticsLib.breedingSeed` (including the entropy
input described above) and emits 500+ vectors.

`test/GenerateFreshTestVectors.t.sol` / `test-vectors-fresh.json` is a
second, independent fixture generator using a deliberately different
token-ID range, gene formula, and entropy salt than the primary one - a
staleness/overfitting guard so a TS port that was hardcoded against the
primary fixture's specific numbers (rather than genuinely re-implementing
`GeneticsLib`'s arithmetic) still gets caught.

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
   `HoodchanBabies` first (its constructor needs both addresses), then
   `BreedingController`, then `babies.setBreedingController(controller)`.
4. **After** deploy: run the off-chain HOODCHAN metadata-sync script (not
   part of this package) to populate `hoodchanGenes`/`upgradedAllowlist`
   for every live HOODCHAN token before any `commitBreed` call - the
   collection is unusable for siring until that sync runs
   (`GenesNotSet`).
5. The TBA-deploy-readiness note above: minting works immediately after
   deploy; TBA `execute()` calls from a baby/mother's TBA do not, until
   the ERC-6551 implementation itself is separately deployed on Robinhood
   Chain.

**This task never broadcasts to any live chain** - no RPC was ever pointed
at with `--broadcast`, on Robinhood Chain or anywhere else.
