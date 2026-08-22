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
///
/// FIX (2026-08-22): the legendary and mutation branches used to each
/// independently compute `LEGENDARY_RESERVED_START + (x % 8)` over the
/// FULL shared 248..255 band - two disjoint 0.5%/5% probability events
/// landing in the exact same 8-value range with no way to tell, after the
/// fact, which branch actually produced a given byte. Fixed by PINNING two
/// non-overlapping sub-ranges within that same 248..255 band: legendary
/// gets 251..255 (5 values), mutation gets 248..250 (3 values). See
/// `LEGENDARY_START`/`LEGENDARY_BAND_SIZE` and
/// `MUTATION_START`/`MUTATION_BAND_SIZE` below - mirrored byte-for-byte in
/// breeding-app/lib/breedingGenetics.ts's `inheritLocus` and classified
/// identically in breeding-app/lib/traitRegistry.ts's `byteToTraitName`.
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

    /// @dev Start of the reserved mutation/legendary index band as a
    /// WHOLE (248..255, 8 values total). Mirrors `LEGENDARY_RESERVED_START
    /// = 248` in breeding-app/lib/traitRegistry.ts exactly - this is
    /// load-bearing, not a coincidence: traitRegistry.ts reserves indices
    /// 248..255 specifically so the off-chain trait-name registry never
    /// assigns a real trait to a byte value this contract might emit for a
    /// mutation or legendary roll. The two branches below now PIN disjoint
    /// sub-ranges within this shared band instead of both drawing from the
    /// full 8 values - see the library-level FIX note above.
    uint8 internal constant LEGENDARY_RESERVED_START = 248;

    /// @dev Legendary branch's PINNED sub-range: 251..255 inclusive (5
    /// values), disjoint from the mutation branch's 248..250.
    uint8 internal constant LEGENDARY_START = 251;
    uint8 internal constant LEGENDARY_BAND_SIZE = 5;

    /// @dev Mutation branch's PINNED sub-range: 248..250 inclusive (3
    /// values), disjoint from the legendary branch's 251..255.
    uint8 internal constant MUTATION_START = 248;
    uint8 internal constant MUTATION_BAND_SIZE = 3;

    /// @notice Top-level breeding seed. Deterministic, pure function of
    /// public inputs only (both parents' collection+id and a per-breed
    /// nonce) - per the design spec's "Accepted tradeoff" section, this is
    /// a KNOWN, ACCEPTED limitation, not an oversight: the seed is fully
    /// computable off-chain in advance of sending anything, so a caller can
    /// simulate every candidate outcome for FREE and only ever submit the
    /// breed() tx for a roll they like ("breed-sniping"). A rejected
    /// simulation costs nothing - no CHAN spent, no cooldown burned, no tx
    /// sent at all - so re-rolling is not actually rate-limited by the fee
    /// or cooldown in any way that resists a determined off-chain
    /// simulator. This is accepted for v1 anyway: the tradeoff buys an
    /// open, independently-verifiable genetics algorithm (unlike
    /// CryptoKitties' closed-oracle equivalent), and closing it requires
    /// real seed-hiding machinery (commit/reveal, VRF, blockhash
    /// anchoring) that this design deliberately does not have. Do not
    /// reintroduce blockhash anchoring, a two-step escrow-then-later-
    /// finalize seed-hiding scheme, or VRF here to "fix" this - it is a
    /// known, accepted property of v1, not a bug to patch.
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
    ///   - bits [8:16)  (`(locusSeed >> 8) % 5`)      -> legendary's pinned-range offset (251..255)
    ///   - bits [16:32) (`(locusSeed >> 16) % 10000`) -> mutation check
    ///   - bits [24:32) (`(locusSeed >> 24) % 3`)     -> mutation's pinned-range offset (248..250)
    ///   - bit  [32]    (`(locusSeed >> 32) % 2`)     -> matron/sire coin flip
    function inheritLocus(uint8 p1, uint8 p2, uint256 seed, uint256 offset) internal pure returns (uint8) {
        uint256 locusSeed = uint256(keccak256(abi.encodePacked(seed, offset)));

        if ((locusSeed % 10000) < LEGENDARY_MUTATION_RATE) {
            // 0.5%: legendary. Clamped into its PINNED sub-range,
            // 251..255, via modulo (never an unconstrained byte) - a
            // brand-new value, unrelated to either parent. Pinned disjoint
            // from the mutation branch's 248..250 below (see the
            // library-level FIX note) so a legendary byte and a mutation
            // byte can never be confused with each other after the fact.
            return uint8(LEGENDARY_START + uint8((locusSeed >> 8) % LEGENDARY_BAND_SIZE));
        } else if (((locusSeed >> 16) % 10000) < BASE_MUTATION_RATE) {
            // 5%: base mutation. Clamped into its OWN pinned sub-range,
            // 248..250 - disjoint from the legendary branch's 251..255
            // above, via an independent bit-slice, so a mutation roll and
            // a legendary roll are drawn from independent randomness AND
            // land in non-overlapping ranges - no range arithmetic against
            // the parents' values here at all, which is exactly what the
            // prior attempt's `lo + (mag % (range * 3))` formula got wrong
            // (it could overflow into real trait indices).
            return uint8(MUTATION_START + uint8((locusSeed >> 24) % MUTATION_BAND_SIZE));
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
