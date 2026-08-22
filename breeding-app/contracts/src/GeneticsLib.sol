// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GeneticsLib
/// @notice Per-locus genetic inheritance for HOODCHAN breeding's flat
/// 5-slot genome (Hat, Face, Body, Background, Accessory - one uint8 locus
/// per slot). Rewritten for the v2 design spec
/// (docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md):
/// straight 50/50 coin-flip inheritance (band-agnostic - no "numerically
/// higher index wins" dominance rule, which the v1 attempt had and which
/// always favored whichever collection happened to occupy the higher trait
/// index band), plus a mutation/legendary layer that is CLAMPED into the
/// reserved 248..255 index band (`LEGENDARY_RESERVED_START` in
/// breeding-app/lib/traitRegistry.ts) so neither branch can ever collide
/// with a real trait index or overflow a slot's real range - the v1
/// attempt's legendary branch returned an arbitrary unconstrained byte and
/// its mutation branch did range arithmetic that could do the same; both
/// are superseded here.
library GeneticsLib {
    /// @dev Number of gene slots in a HOODCHAN-baby genome: Hat, Face,
    /// Body, Background, Accessory (see BreedingController's slot table).
    uint8 internal constant GENE_SLOTS = 5;

    // Same probability basis as the prior attempt's arithmetic, in
    // basis-points-of-10000 (not the usual 10000=100% convention elsewhere
    // in this contract's fee math - kept here for parity with the `%
    // 10000` comparisons below).
    uint16 internal constant LEGENDARY_MUTATION_RATE = 50; // 0.5%
    uint16 internal constant BASE_MUTATION_RATE = 500; // 5%

    /// @dev Start of the reserved mutation/legendary index band. Mirrors
    /// `LEGENDARY_RESERVED_START = 248` in
    /// breeding-app/lib/traitRegistry.ts exactly - this is load-bearing,
    /// not a coincidence: traitRegistry.ts reserves indices 248..255 (8
    /// values) specifically so the off-chain trait-name registry never
    /// assigns a real trait to a byte value this contract might emit for a
    /// mutation or legendary roll.
    uint8 internal constant LEGENDARY_RESERVED_START = 248;

    /// @dev Size of the reserved band: 248..255 inclusive = 8 values.
    uint8 internal constant LEGENDARY_BAND_SIZE = 8;

    /// @notice Top-level breeding seed. Deterministic, pure function of
    /// public inputs only (both parents' collection+id and a per-breed
    /// nonce) - per the design spec's "Accepted tradeoff" section, this is
    /// a KNOWN, ACCEPTED limitation (a sophisticated caller can simulate
    /// the outcome before sending the breed tx and choose whether to send
    /// it), not an oversight. Do not reintroduce blockhash anchoring, a
    /// two-step escrow-then-later-finalize seed-hiding scheme, or VRF here
    /// - the escalating cooldown and unconditional birth fee are the
    /// spec's chosen mitigation instead (re-rolling costs real CHAN and
    /// burns real cooldown time).
    function breedingSeed(
        address matronCollection,
        uint256 matronId,
        address sireCollection,
        uint256 sireId,
        uint256 nonce
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(matronCollection, matronId, sireCollection, sireId, nonce)));
    }

    /// @notice Resolves all 5 gene-slot values for a child from its
    /// parents' gene arrays and the top-level breeding seed. Each slot is
    /// independent (offset = slot index 0..4), so slot i's outcome never
    /// affects slot j's.
    function resolveGenome(uint8[5] memory matronGenes, uint8[5] memory sireGenes, uint256 seed)
        internal
        pure
        returns (uint8[5] memory genome)
    {
        for (uint256 i = 0; i < GENE_SLOTS; i++) {
            genome[i] = inheritLocus(matronGenes[i], sireGenes[i], seed, i);
        }
    }

    /// @notice One extra, independent coin flip that decides the baby's
    /// own sex tag - NOT a gene slot (doesn't touch `resolveGenome` or its
    /// offsets at all). Uses offset = GENE_SLOTS (5) so its keccak256 input
    /// never collides with a real gene-slot locus (which only ever use
    /// offsets 0..4), while still reusing the same "one keccak256, slice
    /// the bits" shape as `inheritLocus` below.
    function resolveBabyIsMale(uint256 seed) internal pure returns (bool isMale) {
        uint256 sexSeed = uint256(keccak256(abi.encodePacked(seed, GENE_SLOTS)));
        isMale = (sexSeed % 2) == 0;
    }

    /// @notice Single-locus inheritance. Checks are SEQUENTIAL
    /// if/else-if/else (not three independent draws), ONE keccak256 per
    /// locus, reusing different bit-slices of the SAME hash for each check
    /// rather than hashing again per check - this skeleton is carried
    /// forward unchanged from the prior attempt; only the branch OUTCOMES
    /// changed per the design spec:
    ///   - bits [0:16)  (`locusSeed % 10000`)        -> legendary check
    ///   - bits [8:16)  (`(locusSeed >> 8) % 8`)      -> legendary's band offset
    ///   - bits [16:32) (`(locusSeed >> 16) % 10000`) -> mutation check
    ///   - bits [24:32) (`(locusSeed >> 24) % 8`)     -> mutation's band offset
    ///   - bit  [32]    (`(locusSeed >> 32) % 2`)     -> matron/sire coin flip
    function inheritLocus(uint8 p1, uint8 p2, uint256 seed, uint256 offset) internal pure returns (uint8) {
        uint256 locusSeed = uint256(keccak256(abi.encodePacked(seed, offset)));

        if ((locusSeed % 10000) < LEGENDARY_MUTATION_RATE) {
            // 0.5%: legendary. Clamped into the reserved 248..255 band via
            // modulo (never an unconstrained byte) - a brand-new value,
            // unrelated to either parent, but still guaranteed to land in
            // the band traitRegistry.ts reserves for exactly this purpose.
            return uint8(LEGENDARY_RESERVED_START + uint8((locusSeed >> 8) % LEGENDARY_BAND_SIZE));
        } else if (((locusSeed >> 16) % 10000) < BASE_MUTATION_RATE) {
            // 5%: base mutation. Also clamped into the SAME reserved band
            // (per the design spec: "BOTH mutation and legendary outcomes
            // ... clamp into 248..255") via an independent bit-slice, so a
            // mutation roll and a legendary roll are drawn from
            // independent randomness even though they share a target
            // range - no range arithmetic against the parents' values here
            // at all, which is exactly what the prior attempt's
            // `lo + (mag % (range * 3))` formula got wrong (it could
            // overflow into real trait indices).
            return uint8(LEGENDARY_RESERVED_START + uint8((locusSeed >> 24) % LEGENDARY_BAND_SIZE));
        } else {
            // 94.5%: standard 50/50 coin flip between the LITERAL matron
            // and sire values for this slot - band-agnostic, no magnitude
            // ordering. This is the v2 design's core genetics fix: the
            // prior "numerically higher index wins 60%" rule made whichever
            // collection happened to occupy the higher index band always
            // win regardless of which parent it came from.
            return ((locusSeed >> 32) % 2 == 0) ? p1 : p2;
        }
    }
}
