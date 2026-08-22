// breedingGenetics.ts
//
// Faithful TypeScript port of breeding-app/contracts/src/GeneticsLib.sol -
// the on-chain per-locus genetic inheritance algorithm for HOODCHAN
// breeding's flat 5-slot genome (Hat, Face, Body, Background, Accessory).
// Full rewrite for the v2 design spec
// (docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md): straight
// 50/50 coin-flip inheritance (band-agnostic - no "numerically higher index
// wins" dominance rule, which the superseded v1 port had), plus a
// mutation/legendary layer CLAMPED into the reserved 248..255 index band
// (`LEGENDARY_RESERVED_START` in lib/traitRegistry.ts) instead of the v1
// port's unconstrained-byte legendary branch and range-arithmetic mutation
// branch (both of which could collide with real trait indices).
//
// PARITY IS THE ENTIRE POINT OF THIS FILE:
//   - every uint256/bytes32 operation uses BigInt, never `number` - a
//     regular JS number only has 53 bits of safe integer precision, which
//     silently diverges from Solidity's 256-bit arithmetic long before you
//     notice.
//   - hashing uses ethers' solidityPackedKeccak256, which mirrors
//     Solidity's `keccak256(abi.encodePacked(...))` byte-for-byte -
//     encodePacked (tight packing, no padding/length-prefixing) is NOT the
//     same as ABI-encode (encode), and using the wrong one silently
//     produces a different hash for the same logical inputs.
//   - every bit-slice, threshold, and comparison operator below is a
//     line-for-line mirror of GeneticsLib.sol, not a reimplementation from
//     the English description of what it does.
//
// This file is intentionally PURE and byte-level: uint8 genome values in,
// uint8 genome values out, plus the uint256 seed plumbing needed to derive
// them. It has no opinion on what a gene *value* means (e.g. "value 42 in
// the Hat slot = Durag") - that trait-name resolution belongs to
// lib/traitRegistry.ts and its consumers, not here. No database, no
// Next.js, no React - safe to import from a Node script, an API route, or a
// client component alike.
//
// There is no `entropy` input anymore (unlike the superseded v1 port's
// 4-arg `breedingSeed`, which anchored to a commit/reveal `blockhash`) -
// GeneticsLib.breedingSeed is now a PURE function of public, already-known
// inputs only (both parents' collection address + tokenId, and the global
// breed nonce). This is the design spec's explicitly ACCEPTED tradeoff
// ("you get what you get" - see BreedingController.sol's ACCEPTED TRADEOFF
// note): a sophisticated caller can simulate the outcome client-side before
// deciding whether to send the breed tx. Do not reintroduce blockhash
// anchoring, commit/reveal, or VRF here.
//
// Parity is verified in lib/breedingGenetics.parity.test.ts against BOTH
// contracts/test-vectors.json and contracts/test-vectors-fresh.json - 200+
// vectors generated directly by Solidity itself (`forge test`), never
// hand-computed and never generated from this TS implementation, so a
// passing suite there is a real bit-for-bit match against the contract's
// own arithmetic, not just "this looks right". If a mismatch ever shows up
// there, the fix is always on this file, never on the fixtures.
import { solidityPackedKeccak256, getAddress } from "ethers";

/** Number of gene slots in a HOODCHAN-baby genome (Hat, Face, Body,
 * Background, Accessory) - matches GeneticsLib.sol's GENE_SLOTS. Both
 * "slot count" and "locus count" here since HOODCHAN's genome is flat (one
 * locus per slot). */
export const GENE_SLOTS = 5 as const;

/** A HOODCHAN-baby genome (or a parent's gene array): exactly 5 uint8
 * (0-255) values, in slot order [Hat, Face, Body, Background, Accessory].
 * Mirrors Solidity's `uint8[5]`. */
export type Genome = readonly [number, number, number, number, number];

/** Anything that can represent a Solidity `uint256` without precision
 * loss. Numbers/strings are accepted for convenience (token IDs, nonces)
 * but are converted to BigInt immediately - see `toUint256`. */
export type Uint256Like = bigint | number | string;

// ---------------------------------------------------------------------------
// Constants - mirror GeneticsLib.sol verbatim (basis-points-of-10000, not
// the usual 10000=100% convention elsewhere in this app's fee math -
// specifically matching GeneticsLib's own `% 10000` comparisons so this
// port shares identical arithmetic).
// ---------------------------------------------------------------------------

/** 0.5% - GeneticsLib.LEGENDARY_MUTATION_RATE. */
export const LEGENDARY_MUTATION_RATE = 50n;
/** 5% - GeneticsLib.BASE_MUTATION_RATE. */
export const BASE_MUTATION_RATE = 500n;

/** Start of the reserved mutation/legendary index band AS A WHOLE
 * (248..255, 8 values total) - mirrors `LEGENDARY_RESERVED_START = 248` in
 * both GeneticsLib.sol and lib/traitRegistry.ts exactly. Load-bearing, not
 * a coincidence: neither branch below may ever emit a value below this,
 * which would collide with a real trait index.
 *
 * FIX (2026-08-22): the legendary and mutation branches used to each
 * independently compute `LEGENDARY_RESERVED_START + (x % 8)` over this
 * FULL shared band - two disjoint 0.5%/5% probability events landing in
 * the exact same 8-value range with no way to tell, after the fact, which
 * branch produced a given byte. Fixed by PINNING two non-overlapping
 * sub-ranges within this same band - see `LEGENDARY_START`/
 * `LEGENDARY_BAND_SIZE` and `MUTATION_START`/`MUTATION_BAND_SIZE` below,
 * mirrored byte-for-byte from GeneticsLib.sol's identical fix. */
export const LEGENDARY_RESERVED_START = 248n;

/** Legendary branch's PINNED sub-range: 251..255 inclusive (5 values),
 * disjoint from the mutation branch's 248..250. */
export const LEGENDARY_START = 251n;
export const LEGENDARY_BAND_SIZE = 5n;

/** Mutation branch's PINNED sub-range: 248..250 inclusive (3 values),
 * disjoint from the legendary branch's 251..255. */
export const MUTATION_START = 248n;
export const MUTATION_BAND_SIZE = 3n;

// ---------------------------------------------------------------------------
// Input coercion / validation helpers
// ---------------------------------------------------------------------------

/** Coerces a Uint256Like into a BigInt, matching Solidity's `uint256`
 * (non-negative, no fractional component). Throws on anything that isn't a
 * clean non-negative integer, rather than silently truncating. */
function toUint256(value: Uint256Like): bigint {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) {
    throw new RangeError(`expected a non-negative uint256, got ${big}`);
  }
  return big;
}

/** Validates/normalizes a Solidity `address` (checksums via ethers, which
 * also rejects malformed hex) - both `matronCollection`/`sireCollection`
 * arguments to `breedingSeed` are this type on-chain. */
function toAddress(value: string): string {
  return getAddress(value);
}

/** Asserts a gene/genome value is a valid Solidity `uint8` (integer,
 * 0-255). Off-chain callers may hand this module untrusted JSON/API
 * responses, unlike Solidity where the type system guarantees this. */
function assertUint8(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`expected a uint8 (0-255) for ${label}, got ${value}`);
  }
}

/** Validates a parent gene array / genome is exactly GENE_SLOTS uint8
 * values, returning it typed as `Genome`. */
export function assertGenome(
  genes: readonly number[],
  label = "genes",
): Genome {
  if (genes.length !== GENE_SLOTS) {
    throw new RangeError(
      `expected ${GENE_SLOTS} ${label}, got ${genes.length}`,
    );
  }
  genes.forEach((g, i) => assertUint8(g, `${label}[${i}]`));
  return genes as unknown as Genome;
}

// ---------------------------------------------------------------------------
// Seed derivation - exact port of GeneticsLib.breedingSeed /
// GeneticsLib.inheritLocus's internal per-locus hash / resolveBabyIsMale's
// sex-bit hash.
// ---------------------------------------------------------------------------

/**
 * Port of `GeneticsLib.breedingSeed(matronCollection, matronId,
 * sireCollection, sireId, nonce)`:
 *
 *   keccak256(abi.encodePacked(matronCollection, matronId, sireCollection, sireId, nonce))
 *
 * Deterministic and independently re-computable by anyone off the emitted
 * `Bred` event alone (or even before the tx lands, per the design spec's
 * accepted tradeoff - see this file's header): same five inputs always
 * produce the same seed.
 */
export function breedingSeed(
  matronCollection: string,
  matronId: Uint256Like,
  sireCollection: string,
  sireId: Uint256Like,
  nonce: Uint256Like,
): bigint {
  const hex = solidityPackedKeccak256(
    ["address", "uint256", "address", "uint256", "uint256"],
    [
      toAddress(matronCollection),
      toUint256(matronId),
      toAddress(sireCollection),
      toUint256(sireId),
      toUint256(nonce),
    ],
  );
  return BigInt(hex);
}

/**
 * Port of the per-locus hash inside `GeneticsLib.inheritLocus`:
 *
 *   uint256 locusSeed = uint256(keccak256(abi.encodePacked(seed, offset)))
 *
 * Exposed separately (rather than only inlined in `inheritLocus`) so
 * callers that need to inspect a specific locus's raw hash - e.g. to
 * explain *why* a slot resolved the way it did - don't have to
 * re-implement this hashing step themselves.
 */
export function locusSeedFor(seed: bigint, offset: Uint256Like): bigint {
  const hex = solidityPackedKeccak256(
    ["uint256", "uint256"],
    [toUint256(seed), toUint256(offset)],
  );
  return BigInt(hex);
}

/**
 * Port of `GeneticsLib.resolveBabyIsMale(seed)`:
 *
 *   uint256 sexSeed = uint256(keccak256(abi.encodePacked(seed, GENE_SLOTS)));
 *   isMale = (sexSeed % 2) == 0;
 *
 * One extra, independent coin flip that decides the baby's own sex tag -
 * NOT a gene slot (doesn't touch `resolveGenome` or its offsets at all).
 * `GENE_SLOTS` (5) is packed as a `uint8` here, matching its Solidity
 * declaration (`uint8 internal constant GENE_SLOTS = 5`) exactly - using
 * `uint256` instead would silently produce a different hash even though
 * the numeric value is the same, since `abi.encodePacked` is sensitive to
 * the exact declared type width, not just the value.
 */
export function resolveBabyIsMale(seed: bigint): boolean {
  const hex = solidityPackedKeccak256(
    ["uint256", "uint8"],
    [toUint256(seed), GENE_SLOTS],
  );
  const sexSeed = BigInt(hex);
  return sexSeed % 2n === 0n;
}

// ---------------------------------------------------------------------------
// Core locus inheritance - exact port of GeneticsLib.inheritLocus
// ---------------------------------------------------------------------------

/**
 * Port of `GeneticsLib.inheritLocus(p1, p2, seed, offset)`. Determines the
 * child value for one gene slot given both parents' values at that slot
 * and the top-level breeding seed. Checks are SEQUENTIAL if/else-if/else
 * (not three independent draws), ONE keccak256 per locus, reusing
 * different bit-slices of the SAME hash for each check rather than hashing
 * again per check - this bit-slice reuse is load-bearing for parity, not
 * just an optimization detail:
 *
 *   - bits [0:16)  (`locusSeed % 10000`)         -> legendary check
 *   - bits [8:16)  (`(locusSeed >> 8) % 5`)       -> legendary's pinned-range offset (251..255)
 *   - bits [16:32) (`(locusSeed >> 16) % 10000`)  -> mutation check
 *   - bits [24:32) (`(locusSeed >> 24) % 3`)      -> mutation's pinned-range offset (248..250)
 *   - bit  [32]    (`(locusSeed >> 32) % 2`)      -> matron/sire coin flip
 *
 * The legendary and mutation branches are CLAMPED into their own PINNED,
 * NON-OVERLAPPING sub-ranges within the shared 248..255 reserved band -
 * legendary gets 251..255, mutation gets 248..250 - so neither branch can
 * ever collide with a real trait index, overflow a slot's real range, OR
 * be confused with each other's output (a real collision bug this file and
 * GeneticsLib.sol both had until 2026-08-22, when both independently
 * computed `LEGENDARY_RESERVED_START + (x % 8)` over the full shared
 * band). The standard branch is a plain 50/50 coin flip between the
 * LITERAL matron and sire values - band-agnostic, no magnitude ordering
 * (the v2 design's core genetics fix over v1's "numerically higher index
 * wins 60%" dominance rule, which always favored whichever collection
 * happened to occupy the higher index band regardless of which parent it
 * came from).
 */
export function inheritLocus(
  p1: number,
  p2: number,
  seed: bigint,
  offset: Uint256Like,
): number {
  assertUint8(p1, "p1");
  assertUint8(p2, "p2");

  const locusSeed = locusSeedFor(seed, offset);

  // --- Legendary: 0.5%, pinned 251..255 ---
  if (locusSeed % 10000n < LEGENDARY_MUTATION_RATE) {
    return Number(LEGENDARY_START + ((locusSeed >> 8n) % LEGENDARY_BAND_SIZE));
  }

  // --- Base mutation: 5%, pinned 248..250 ---
  if ((locusSeed >> 16n) % 10000n < BASE_MUTATION_RATE) {
    return Number(MUTATION_START + ((locusSeed >> 24n) % MUTATION_BAND_SIZE));
  }

  // --- Standard 50/50 coin flip: 94.5% ---
  const useP1 = (locusSeed >> 32n) % 2n === 0n;
  return useP1 ? p1 : p2;
}

// ---------------------------------------------------------------------------
// Genome-level resolution - exact port of GeneticsLib.resolveGenome
// ---------------------------------------------------------------------------

/**
 * Port of `GeneticsLib.resolveGenome(matronGenes, sireGenes, seed)`.
 * Resolves all GENE_SLOTS gene-slot values for a child from both parents'
 * gene arrays and the top-level breeding seed. Each slot is independent
 * (offset = slot index 0..4, matching GeneticsLib's per-locus `offset`
 * parameter), so slot i's outcome never affects slot j's.
 */
export function resolveGenome(
  matronGenes: Genome | readonly number[],
  sireGenes: Genome | readonly number[],
  seed: bigint,
): Genome {
  const matron = assertGenome(matronGenes, "matronGenes");
  const sire = assertGenome(sireGenes, "sireGenes");

  const genome: number[] = [];
  for (let i = 0; i < GENE_SLOTS; i++) {
    genome.push(inheritLocus(matron[i], sire[i], seed, BigInt(i)));
  }
  return genome as unknown as Genome;
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export interface BreedResult {
  seed: bigint;
  genome: Genome;
  babyIsMale: boolean;
  /** `matronSex === sireSex` at breed time - the "test tube baby" pricing
   * tier / cosmetic badge (BreedingController.breed()'s `sameSex` local,
   * stored as `HoodchanBabies.isTestTubeBaby`). NOT derived from the seed
   * at all - purely a function of both parents' sex tags, which the caller
   * must supply since this module has no on-chain read access. */
  isTestTubeBaby: boolean;
}

/**
 * Convenience wrapper combining `breedingSeed` + `resolveGenome` +
 * `resolveBabyIsMale` in one call - the typical entry point for locally
 * previewing/re-verifying a breed's outcome off its public inputs (both
 * parents' collection+id, the breed nonce, and both parents' current gene
 * arrays + sex tags).
 */
export function breedGenome(
  matronCollection: string,
  matronId: Uint256Like,
  sireCollection: string,
  sireId: Uint256Like,
  nonce: Uint256Like,
  matronGenes: Genome | readonly number[],
  sireGenes: Genome | readonly number[],
  matronSex: boolean,
  sireSex: boolean,
): BreedResult {
  const seed = breedingSeed(
    matronCollection,
    matronId,
    sireCollection,
    sireId,
    nonce,
  );
  const genome = resolveGenome(matronGenes, sireGenes, seed);
  const babyIsMale = resolveBabyIsMale(seed);
  return { seed, genome, babyIsMale, isTestTubeBaby: matronSex === sireSex };
}

/** Structural equality for two genomes - e.g. comparing a locally
 * recomputed genome against an emitted on-chain genome as a real fairness
 * check (a mismatch here should be a hard error at the call site, not
 * silently ignored). */
export function genomesEqual(
  a: readonly number[],
  b: readonly number[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}
