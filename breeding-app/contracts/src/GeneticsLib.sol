// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GeneticsLib
/// @notice Bit-for-bit port of AquaPrime's per-locus genetic inheritance
/// algorithm (see AquaPrimeGenetics.sol#_inheritSingleLocus in the
/// AQUAPRIME_RPG repo, the source of truth this was ported from), narrowed
/// from AquaPrime's 4-allele/multi-trait genome down to HOODCHAN breeding's
/// flat 5-slot genome (Hat, Face, Body, Background, Accessory - one uint8
/// locus per slot, see BreedingController's GENE_SLOTS). Reusing
/// AquaPrime's exact arithmetic (not a reimplementation) is what makes the
/// off-chain TS parity task tractable: same seed derivation, same bit
/// slices of the same keccak256, same plain `% 10000` thresholds (no
/// rejection sampling - the ~0.006% bias this introduces at the boundary
/// is negligible and matching AquaPrime's exact integer math is what
/// matters for parity, not statistical purity).
library GeneticsLib {
    /// @dev Number of gene slots in a HOODCHAN-baby genome: Hat, Face,
    /// Body, Background, Accessory (see BreedingController's slot table).
    /// AquaPrime's genome has multiple gene *categories* each built from
    /// several *loci* (dominant/r1/r2/r3); HOODCHAN's genome is flatter -
    /// exactly one locus per slot - so this is both "slot count" and
    /// "locus count" here, unlike AquaPrime where those differ.
    uint8 internal constant GENE_SLOTS = 5;

    // Same three constants as AquaPrimeGenetics.sol, in basis-points-of-
    // 10000 (not the usual 10000=100% basis-point convention elsewhere in
    // Solidity - specifically mirrored from AquaPrime's own `% 10000`
    // comparisons so the two contracts share identical arithmetic).
    uint16 internal constant LEGENDARY_MUTATION_RATE = 50; // 0.5%
    uint16 internal constant BASE_MUTATION_RATE = 500; // 5%
    uint16 internal constant DOMINANT_INHERITANCE_RATE = 6000; // 60%

    /// @notice Top-level breeding seed. Takes an explicit `entropy` input
    /// (rather than overloading `breedNonce`) that BreedingController
    /// derives from `blockhash(commitBlock)` in its commit/reveal flow -
    /// see BreedingController's SEED-FAIRNESS MITIGATION note. Unlike
    /// `fatherTokenId`/`motherTokenId`/`breedNonce` (all public and
    /// readable before a breeding tx lands), `entropy` is the hash of a
    /// block that does not exist yet at commit time, which is what closes
    /// the pre-computation ("breed-sniping") window a naive
    /// `keccak256(fatherTokenId, motherTokenId, breedNonce)` seed would
    /// otherwise have. This function itself stays a pure, deterministic
    /// combination of its four inputs - it has no opinion on WHERE
    /// `entropy` comes from, only that BreedingController is responsible
    /// for supplying something that isn't known in advance.
    function breedingSeed(uint256 fatherTokenId, uint256 motherTokenId, uint256 breedNonce, bytes32 entropy)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(fatherTokenId, motherTokenId, breedNonce, entropy)));
    }

    /// @notice Resolves all 5 gene-slot values for a child from its
    /// parents' gene arrays and the top-level breeding seed. Each slot is
    /// independent (offset = slot index 0..4, matching AquaPrime's
    /// per-locus `offset` parameter), so slot i's outcome never affects
    /// slot j's.
    function resolveGenome(uint8[5] memory fatherGenes, uint8[5] memory motherGenes, uint256 seed)
        internal
        pure
        returns (uint8[5] memory genome)
    {
        for (uint256 i = 0; i < GENE_SLOTS; i++) {
            genome[i] = inheritLocus(fatherGenes[i], motherGenes[i], seed, i);
        }
    }

    /// @notice Single-locus inheritance - exact port of AquaPrimeGenetics's
    /// `_inheritSingleLocus`. Checks are SEQUENTIAL if/else-if/else (not
    /// three independent draws), ONE keccak256 per locus, reusing
    /// different bit-slices of the SAME hash for each check rather than
    /// hashing again per check:
    ///   - bits [0:16)  (`locusSeed % 10000`)        -> legendary check
    ///   - bits [8:16)  (`(locusSeed >> 8) & 0xFF`)   -> legendary's new value
    ///   - bits [16:32) (`(locusSeed >> 16) % 10000`) -> mutation check
    ///   - bits [24:32) (`(locusSeed >> 24) & 0xFF`)  -> mutation magnitude
    ///   - bits [32:48) (`(locusSeed >> 32) % 10000`) -> dominant/recessive draw
    /// This bit-slice reuse (rather than one keccak256 per decision) is
    /// exactly what AquaPrime does and is load-bearing for TS parity - the
    /// off-chain port must replicate the same slicing, not just the same
    /// probabilities.
    function inheritLocus(uint8 p1, uint8 p2, uint256 seed, uint256 offset) internal pure returns (uint8) {
        uint256 locusSeed = uint256(keccak256(abi.encodePacked(seed, offset)));

        if ((locusSeed % 10000) < LEGENDARY_MUTATION_RATE) {
            // 0.5%: legendary - a brand-new value, unrelated to either
            // parent (deliberately NOT range-constrained, unlike the base
            // mutation branch below - that asymmetry is the whole point of
            // calling it "legendary").
            return uint8((locusSeed >> 8) & 0xFF);
        } else if (((locusSeed >> 16) % 10000) < BASE_MUTATION_RATE) {
            // 5%: base mutation - a value near the parents' range, not a
            // uniformly random byte. `range * 3` (rather than just
            // `range`) lets the mutated value land somewhat outside the
            // [lo, hi] parent interval in either direction, not just
            // between the two parents - AquaPrime's exact formula.
            uint16 mag = uint16((locusSeed >> 24) & 0xFF);
            uint16 lo = p1 < p2 ? uint16(p1) : uint16(p2);
            uint16 hi = p1 > p2 ? uint16(p1) : uint16(p2);
            uint16 range = hi > lo ? hi - lo : 1;
            uint16 val = lo + (mag % (range * 3));
            return uint8(val > 255 ? 255 : val);
        } else {
            // 94.5%: standard 60/40 dominant/recessive inheritance.
            // "Dominant" here means numerically higher, strictly (`>`,
            // matching AquaPrime) - equal parent values fall through to
            // `recessive`, which is fine since dominant==recessive in that
            // case anyway.
            uint8 dominant = p1 > p2 ? p1 : p2;
            uint8 recessive = p1 <= p2 ? p1 : p2;
            return ((locusSeed >> 32) % 10000 < DOMINANT_INHERITANCE_RATE) ? dominant : recessive;
        }
    }
}
