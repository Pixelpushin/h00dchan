// breedingGenetics.ts
//
// Faithful TypeScript port of breeding-app/contracts/src/GeneticsLib.sol -
// the on-chain per-locus genetic inheritance algorithm for HOODCHAN
// breeding (itself a bit-for-bit port of AquaPrime's AquaPrimeGenetics.sol
// #_inheritSingleLocus, narrowed from AquaPrime's 4-allele/multi-trait
// genome down to HOODCHAN's flat 5-slot genome: Hat, Face, Body,
// Background, Accessory).
//
// PARITY IS THE ENTIRE POINT OF THIS FILE:
//   - every uint256/bytes32 operation uses BigInt, never `number` - a
//     regular JS number only has 53 bits of safe integer precision, which
//     silently diverges from Solidity's 256-bit arithmetic long before you
//     notice (this was the exact failure mode of a prior, discarded
//     attempt at this file).
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
// uint8 genome values out, plus the uint256 seed/bytes32 entropy plumbing
// needed to derive them. It has no opinion on what a gene *value* means
// (e.g. "value 42 in the Hat slot = Durag") - that trait-name resolution
// belongs to lib/traitRegistry.ts and its consumers, not here. No
// database, no Next.js, no React - safe to import from a Node script, an
// API route, or a client component alike.
//
// `entropy` (breedingSeed's 4th argument) is `blockhash(commitBlock)` in
// production - see BreedingController.sol's SEED-FAIRNESS MITIGATION note.
// This module has no opinion on where it comes from, only that it must be
// supplied as a bytes32, matching GeneticsLib.sol's own signature exactly.
//
// Parity is verified in lib/breedingGenetics.parity.test.ts against BOTH
// contracts/test-vectors.json and contracts/test-vectors-fresh.json -
// 600+ vectors generated directly by Solidity itself (`forge test`), never
// hand-computed and never generated from this TS implementation, so a
// passing suite there is a real bit-for-bit match against the contract's
// own arithmetic, not just "this looks right". If a mismatch ever shows up
// there, the fix is always on this file, never on the fixtures.
import { solidityPackedKeccak256 } from "ethers";

/** Number of gene slots in a HOODCHAN-baby genome (Hat, Face, Body,
 * Background, Accessory) - matches GeneticsLib.sol's GENE_SLOTS. Both
 * "slot count" and "locus count" here since HOODCHAN's genome is flat
 * (one locus per slot), unlike AquaPrime's multi-locus genes. */
export const GENE_SLOTS = 5 as const;
/** @deprecated alias of {@link GENE_SLOTS} for compatibility with earlier
 * in-flight naming. */
export const GENE_SLOTS_COUNT = GENE_SLOTS;

/** A HOODCHAN-baby genome (or a parent's gene array): exactly 5 uint8
 * (0-255) values, in slot order [Hat, Face, Body, Background, Accessory].
 * Mirrors Solidity's `uint8[5]`. */
export type Genome = readonly [number, number, number, number, number];

/** Anything that can represent a Solidity `uint256` without precision
 * loss. Numbers/strings are accepted for convenience (token IDs, nonces)
 * but are converted to BigInt immediately - see `toUint256`. */
export type Uint256Like = bigint | number | string;

/** A Solidity `bytes32` value as a `0x`-prefixed, 32-byte hex string
 * (e.g. a block hash from a provider, or GeneticsLib's `entropy` input). */
export type Bytes32Hex = string;

// ---------------------------------------------------------------------------
// Constants - mirror GeneticsLib.sol verbatim (basis-points-of-10000, not
// the usual 10000=100% convention - specifically matching GeneticsLib's own
// `% 10000` comparisons so this port shares identical arithmetic).
// ---------------------------------------------------------------------------

/** 0.5% - GeneticsLib.LEGENDARY_MUTATION_RATE. */
export const LEGENDARY_MUTATION_RATE = 50n;
/** 5% - GeneticsLib.BASE_MUTATION_RATE. */
export const BASE_MUTATION_RATE = 500n;
/** 60% - GeneticsLib.DOMINANT_INHERITANCE_RATE. */
export const DOMINANT_INHERITANCE_RATE = 6000n;

const MASK_8 = 0xffn;
const BYTES32_HEX_LENGTH = 66; // "0x" + 64 hex chars

// ---------------------------------------------------------------------------
// Input coercion / validation helpers
// ---------------------------------------------------------------------------

/** Coerces a Uint256Like into a BigInt, matching Solidity's `uint256`
 * (non-negative, no fractional component). Throws on anything that isn't
 * a clean non-negative integer, rather than silently truncating. */
function toUint256(value: Uint256Like): bigint {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) {
    throw new RangeError(`expected a non-negative uint256, got ${big}`);
  }
  return big;
}

/** Validates/normalizes a Solidity `bytes32` hex string (the `entropy`
 * input to `breedingSeed`, e.g. a `blockhash(commitBlock)` value read off
 * a provider). Accepts any casing, always returns lowercase. */
function toBytes32Hex(value: Bytes32Hex): Bytes32Hex {
  if (
    typeof value !== "string" ||
    value.length !== BYTES32_HEX_LENGTH ||
    !value.startsWith("0x") ||
    !/^0x[0-9a-fA-F]{64}$/.test(value)
  ) {
    throw new RangeError(
      `expected a 0x-prefixed 32-byte hex string (bytes32), got ${String(value)}`,
    );
  }
  return value.toLowerCase();
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
// GeneticsLib.inheritLocus's internal per-locus hash.
// ---------------------------------------------------------------------------

/**
 * Port of `GeneticsLib.breedingSeed(fatherTokenId, motherTokenId,
 * breedNonce, entropy)`:
 *
 *   keccak256(abi.encodePacked(fatherTokenId, motherTokenId, breedNonce, entropy))
 *
 * `entropy` is whatever BreedingController.revealBreed anchors to
 * on-chain (`blockhash(commitBlock)` in the commit/reveal flow - see
 * BreedingController's SEED-FAIRNESS MITIGATION note) - this function
 * itself has no opinion on where it comes from, only that it's a
 * `bytes32`. Deterministic and independently re-computable by anyone off
 * the emitted reveal event alone: same four inputs always produce the
 * same seed.
 */
export function breedingSeed(
  fatherTokenId: Uint256Like,
  motherTokenId: Uint256Like,
  breedNonce: Uint256Like,
  entropy: Bytes32Hex,
): bigint {
  const hex = solidityPackedKeccak256(
    ["uint256", "uint256", "uint256", "bytes32"],
    [
      toUint256(fatherTokenId),
      toUint256(motherTokenId),
      toUint256(breedNonce),
      toBytes32Hex(entropy),
    ],
  );
  return BigInt(hex);
}

/** @deprecated alias of {@link breedingSeed} for compatibility with
 * earlier in-flight naming. */
export const computeBreedingSeed = breedingSeed;

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

// ---------------------------------------------------------------------------
// Core locus inheritance - exact port of GeneticsLib.inheritLocus
// ---------------------------------------------------------------------------

/**
 * Port of `GeneticsLib.inheritLocus(p1, p2, seed, offset)`. Determines the
 * child value for one gene slot given both parents' values at that slot
 * and the top-level breeding seed. Decision tree mirrors the Solidity
 * SEQUENTIAL if/else-if/else exactly (not three independent draws), using
 * ONE keccak256 per locus and different bit-slices of that SAME hash for
 * each check - this bit-slice reuse (rather than hashing again per
 * decision) is load-bearing for parity, not just an optimization detail:
 *
 *   - bits [0:16)  (`locusSeed % 10000`)         -> legendary check
 *   - bits [8:16)  (`(locusSeed >> 8) & 0xFF`)    -> legendary's new value
 *   - bits [16:32) (`(locusSeed >> 16) % 10000`)  -> mutation check
 *   - bits [24:32) (`(locusSeed >> 24) & 0xFF`)   -> mutation magnitude
 *   - bits [32:48) (`(locusSeed >> 32) % 10000`)  -> dominant/recessive draw
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
  const p1b = BigInt(p1);
  const p2b = BigInt(p2);

  // --- Legendary mutation: 0.5% ---
  if (locusSeed % 10000n < LEGENDARY_MUTATION_RATE) {
    // A brand-new value, unrelated to either parent - deliberately NOT
    // range-constrained, unlike the base mutation branch below (that
    // asymmetry is the whole point of calling it "legendary").
    return Number((locusSeed >> 8n) & MASK_8);
  }

  // --- Base mutation: 5% ---
  if ((locusSeed >> 16n) % 10000n < BASE_MUTATION_RATE) {
    // A value near the parents' range, not a uniformly random byte.
    // `range * 3` (rather than just `range`) lets the mutated value land
    // somewhat outside the [lo, hi] parent interval in either direction,
    // not just between the two parents - GeneticsLib's exact formula.
    const mag = (locusSeed >> 24n) & MASK_8;
    const lo = p1b < p2b ? p1b : p2b;
    const hi = p1b > p2b ? p1b : p2b;
    const range = hi > lo ? hi - lo : 1n;
    const val = lo + (mag % (range * 3n));
    return Number(val > 255n ? 255n : val);
  }

  // --- Standard 60/40 dominant/recessive inheritance: 94.5% ---
  // "Dominant" means numerically higher, strictly (`>`, matching
  // GeneticsLib) - equal parent values fall through to `recessive`, which
  // is fine since dominant === recessive in that case anyway.
  const dominant = p1b > p2b ? p1b : p2b;
  const recessive = p1b <= p2b ? p1b : p2b;
  const useDominant = (locusSeed >> 32n) % 10000n < DOMINANT_INHERITANCE_RATE;
  return Number(useDominant ? dominant : recessive);
}

// ---------------------------------------------------------------------------
// Genome-level resolution - exact port of GeneticsLib.resolveGenome
// ---------------------------------------------------------------------------

/**
 * Port of `GeneticsLib.resolveGenome(fatherGenes, motherGenes, seed)`.
 * Resolves all GENE_SLOTS gene-slot values for a child from both parents'
 * gene arrays and the top-level breeding seed. Each slot is independent
 * (offset = slot index 0..4, matching GeneticsLib's per-locus `offset`
 * parameter), so slot i's outcome never affects slot j's.
 */
export function resolveGenome(
  fatherGenes: Genome | readonly number[],
  motherGenes: Genome | readonly number[],
  seed: bigint,
): Genome {
  const father = assertGenome(fatherGenes, "fatherGenes");
  const mother = assertGenome(motherGenes, "motherGenes");

  const genome: number[] = [];
  for (let i = 0; i < GENE_SLOTS; i++) {
    genome.push(inheritLocus(father[i], mother[i], seed, BigInt(i)));
  }
  return genome as unknown as Genome;
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper combining `breedingSeed` + `resolveGenome` in one
 * call - the typical entry point for reconstructing a child's true genome
 * off on-chain reveal data (`fatherTokenId`, `motherTokenId`,
 * `breedNonce`, and `blockhash(commitBlock)` as `entropy`, plus both
 * parents' current gene arrays).
 */
export function breedGenome(
  fatherTokenId: Uint256Like,
  motherTokenId: Uint256Like,
  breedNonce: Uint256Like,
  entropy: Bytes32Hex,
  fatherGenes: Genome | readonly number[],
  motherGenes: Genome | readonly number[],
): { seed: bigint; genome: Genome } {
  const seed = breedingSeed(fatherTokenId, motherTokenId, breedNonce, entropy);
  const genome = resolveGenome(fatherGenes, motherGenes, seed);
  return { seed, genome };
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
