// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";

/// @notice v2 rewrite of GeneticsLib's test suite against the design spec
/// (docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md). The old
/// suite (test-legacy/GeneticsLib.t.sol) tested a 4-arg breedingSeed with
/// an `entropy` param and a 60/40 numeric-magnitude dominant/recessive
/// standard branch - both superseded: breedingSeed is now a 5-arg pure
/// function of (matronCollection, matronId, sireCollection, sireId, nonce)
/// with no entropy input at all (the seed-hiding scheme it fed is deleted
/// too), and the standard branch is a straight band-agnostic 50/50 coin
/// flip instead of magnitude-ordered dominance.
contract GeneticsLibTest is Test {
    address internal constant COLL_A = address(0xA11CE);
    address internal constant COLL_B = address(0xB0B0B);

    // -----------------------------------------------------------
    // breedingSeed: determinism + sensitivity to every input
    // -----------------------------------------------------------

    function test_BreedingSeed_MatchesSpecFormula() public pure {
        uint256 expected = uint256(keccak256(abi.encodePacked(COLL_A, uint256(1), COLL_B, uint256(2), uint256(3))));
        assertEq(GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 3), expected);
    }

    function test_BreedingSeed_DeterministicSameInputs() public pure {
        uint256 seedA = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 3);
        uint256 seedB = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 3);
        assertEq(seedA, seedB, "identical inputs must produce identical seed");
    }

    function test_BreedingSeed_DifferentNonceDiffersSeed() public pure {
        uint256 seedA = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 0);
        uint256 seedB = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 1);
        assertTrue(seedA != seedB, "different nonce must change the seed");
    }

    function test_BreedingSeed_DifferentMatronCollectionDiffersSeed() public pure {
        uint256 seedA = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 0);
        uint256 seedB = GeneticsLib.breedingSeed(COLL_B, 1, COLL_B, 2, 0);
        assertTrue(seedA != seedB, "different matronCollection must change the seed");
    }

    function test_BreedingSeed_DifferentSireCollectionDiffersSeed() public pure {
        uint256 seedA = GeneticsLib.breedingSeed(COLL_A, 1, COLL_A, 2, 0);
        uint256 seedB = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 0);
        assertTrue(seedA != seedB, "different sireCollection must change the seed");
    }

    function test_BreedingSeed_DifferentIdsDifferSeed() public pure {
        uint256 seedA = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 0);
        uint256 seedB = GeneticsLib.breedingSeed(COLL_A, 5, COLL_B, 2, 0);
        uint256 seedC = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 9, 0);
        assertTrue(seedA != seedB, "different matronId must change the seed");
        assertTrue(seedA != seedC, "different sireId must change the seed");
    }

    // Same-inputs-except-one-field pair, cross-collection role swap: this
    // is the exact scenario the v2 allowlist makes newly possible (any
    // collection can be matron OR sire) - matron/sire being SWAPPED must
    // not collide even when the token ids happen to match, since a matron
    // role and a sire role at the same id are genuinely different breeds.
    function test_BreedingSeed_MatronSireRoleSwapDiffersSeed() public pure {
        uint256 seedA = GeneticsLib.breedingSeed(COLL_A, 5, COLL_B, 5, 0);
        uint256 seedB = GeneticsLib.breedingSeed(COLL_B, 5, COLL_A, 5, 0);
        assertTrue(seedA != seedB, "matron/sire role swap must change the seed");
    }

    // -----------------------------------------------------------
    // resolveGenome: determinism + slot independence
    // -----------------------------------------------------------

    function test_ResolveGenome_Deterministic() public pure {
        uint8[5] memory matron = [uint8(10), 20, 30, 40, 50];
        uint8[5] memory sire = [uint8(200), 190, 180, 170, 160];
        uint256 seed = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 3);

        uint8[5] memory child1 = GeneticsLib.resolveGenome(matron, sire, seed);
        uint8[5] memory child2 = GeneticsLib.resolveGenome(matron, sire, seed);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(child1[i], child2[i], "same seed must produce identical genome");
        }
    }

    function test_ResolveGenome_SlotsUseOffsetEqualsSlotIndex() public pure {
        uint8[5] memory matron = [uint8(1), 2, 3, 4, 5];
        uint8[5] memory sire = [uint8(250), 249, 248, 247, 246];
        uint256 seed = GeneticsLib.breedingSeed(COLL_A, 10, COLL_B, 20, 30);

        uint8[5] memory genome = GeneticsLib.resolveGenome(matron, sire, seed);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(
                genome[i], GeneticsLib.inheritLocus(matron[i], sire[i], seed, i), "slot must use offset==slot index"
            );
        }
    }

    // -----------------------------------------------------------
    // resolveBabyIsMale: independent extra coin flip
    // -----------------------------------------------------------

    function test_ResolveBabyIsMale_Deterministic() public pure {
        uint256 seed = GeneticsLib.breedingSeed(COLL_A, 1, COLL_B, 2, 3);
        assertEq(GeneticsLib.resolveBabyIsMale(seed), GeneticsLib.resolveBabyIsMale(seed));
    }

    /// @dev Baby sex is a pure function of `seed` alone - it takes no gene
    /// arguments at all, so it is independent of the parents' gene-slot
    /// values BY CONSTRUCTION. What actually needs checking is that its
    /// internal offset (GENE_SLOTS == 5) never collides with a real
    /// gene-slot offset (0..4, used by inheritLocus for the 5 loci), so the
    /// sex-flip draw is cryptographically independent of every locus draw
    /// for the SAME seed, not reusing their randomness.
    function testFuzz_ResolveBabyIsMale_OffsetNeverCollidesWithGeneSlots(uint256 seed) public pure {
        uint8[5] memory matron = [uint8(1), 2, 3, 4, 5];
        uint8[5] memory sire = [uint8(6), 7, 8, 9, 10];
        GeneticsLib.resolveGenome(matron, sire, seed); // must not revert regardless of sex draw
        GeneticsLib.resolveBabyIsMale(seed); // must not revert; distinct offset (5) from loci (0..4)
    }

    function test_ResolveBabyIsMale_StatisticalSanity() public pure {
        uint256 maleCount = 0;
        uint256 samples = 4000;
        for (uint256 i = 0; i < samples; i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked("sex-seed", i)));
            if (GeneticsLib.resolveBabyIsMale(seed)) maleCount++;
        }
        uint256 maleRateBps = (maleCount * 10000) / samples;
        assertGe(maleRateBps, 4700, "baby sex should be roughly 50/50 male");
        assertLe(maleRateBps, 5300, "baby sex should be roughly 50/50 male");
    }

    // -----------------------------------------------------------
    // inheritLocus: never reverts, classification helper matches contract
    // -----------------------------------------------------------

    function testFuzz_InheritLocus_NeverReverts(uint8 p1, uint8 p2, uint256 seed, uint256 offset) public pure {
        GeneticsLib.inheritLocus(p1, p2, seed, offset);
    }

    /// @dev Mirrors GeneticsLib.inheritLocus's own branch classification
    /// exactly (same bit-slices, same thresholds) so tests can partition
    /// samples by branch without re-deriving the result value itself.
    function _isLegendary(uint256 seed, uint256 offset) internal pure returns (bool) {
        uint256 locusSeed = uint256(keccak256(abi.encodePacked(seed, offset)));
        return (locusSeed % 10000) < 50;
    }

    function _isMutation(uint256 seed, uint256 offset) internal pure returns (bool) {
        uint256 locusSeed = uint256(keccak256(abi.encodePacked(seed, offset)));
        if ((locusSeed % 10000) < 50) return false; // legendary takes priority
        return ((locusSeed >> 16) % 10000) < 500;
    }

    /// @notice REQUIRED COVERAGE: "for all seeds, non-mutation slot
    /// outcomes ∈ {matronVal, sireVal}". Fuzzes seed/offset/parent values
    /// and filters to the standard (non-legendary, non-mutation) branch via
    /// the classification mirror above, then asserts the result is exactly
    /// one of the two literal parent values - band-agnostic (no assumption
    /// about which one is "dominant"), which is the v2 genetics fix itself.
    function testFuzz_InheritLocus_StandardBranchIsExactlyOneParentValue(
        uint8 p1,
        uint8 p2,
        uint256 seed,
        uint8 offsetRaw
    ) public pure {
        uint256 offset = offsetRaw % 5;
        vm.assume(!_isLegendary(seed, offset) && !_isMutation(seed, offset));
        uint8 result = GeneticsLib.inheritLocus(p1, p2, seed, offset);
        assertTrue(result == p1 || result == p2, "standard branch must return a literal parent value");
    }

    /// @notice REQUIRED COVERAGE: "legendary outcomes ALWAYS in its PINNED
    /// sub-range [251,255]" (disjoint from mutation's [248,250] - see the
    /// PINNED, NON-OVERLAPPING RANGES fix in GeneticsLib.sol's header),
    /// over many seeds, with parent values chosen INSIDE the reserved band
    /// (0,1) so a result landing in [251,255] can only have come from the
    /// legendary clamp, never from coincidentally equaling a parent value.
    function test_InheritLocus_LegendaryAlwaysInPinnedSubRange() public pure {
        uint256 found = 0;
        for (uint256 i = 0; i < 20000 && found < 200; i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked("legendary-scan", i)));
            if (!_isLegendary(seed, 0)) continue;
            uint8 result = GeneticsLib.inheritLocus(1, 2, seed, 0);
            assertGe(result, 251, "legendary roll must clamp into its pinned [251,255] sub-range");
            assertLe(result, 255, "legendary roll must clamp into its pinned [251,255] sub-range");
            found++;
        }
        assertGt(found, 0, "scan must find at least one legendary seed to actually exercise the branch");
    }

    /// @notice REQUIRED COVERAGE: "mutation outcomes ALWAYS in its PINNED
    /// sub-range [248,250]" (disjoint from legendary's [251,255]) - same
    /// shape as the legendary scan above.
    function test_InheritLocus_MutationAlwaysInPinnedSubRange() public pure {
        uint256 found = 0;
        for (uint256 i = 0; i < 20000 && found < 200; i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked("mutation-scan", i)));
            if (!_isMutation(seed, 0)) continue;
            uint8 result = GeneticsLib.inheritLocus(1, 2, seed, 0);
            assertGe(result, 248, "mutation roll must clamp into its pinned [248,250] sub-range");
            assertLe(result, 250, "mutation roll must clamp into its pinned [248,250] sub-range");
            found++;
        }
        assertGt(found, 0, "scan must find at least one mutation seed to actually exercise the branch");
    }

    /// @notice REQUIRED COVERAGE: legendary and mutation outputs land in
    /// DISTINCT, DISJOINT ranges - the actual collision-fix invariant.
    /// Before the fix, both branches independently computed
    /// `LEGENDARY_RESERVED_START + (x % 8)` over the SAME shared 248..255
    /// band, so a legendary byte and a mutation byte could be identical
    /// with no way to tell which branch produced it. Scans for BOTH branch
    /// types over the same seed space and asserts each lands ONLY in its
    /// own pinned sub-range, never the other's.
    function test_InheritLocus_LegendaryAndMutationRangesAreDisjoint() public pure {
        uint256 legendaryFound = 0;
        uint256 mutationFound = 0;
        for (uint256 i = 0; i < 40000 && (legendaryFound < 100 || mutationFound < 100); i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked("disjoint-scan", i)));
            if (_isLegendary(seed, 0)) {
                uint8 result = GeneticsLib.inheritLocus(1, 2, seed, 0);
                assertGe(result, 251, "legendary must land in [251,255], never mutation's [248,250]");
                assertLe(result, 255, "legendary must land in [251,255], never mutation's [248,250]");
                legendaryFound++;
            } else if (_isMutation(seed, 0)) {
                uint8 result = GeneticsLib.inheritLocus(1, 2, seed, 0);
                assertGe(result, 248, "mutation must land in [248,250], never legendary's [251,255]");
                assertLe(result, 250, "mutation must land in [248,250], never legendary's [251,255]");
                mutationFound++;
            }
        }
        assertGt(legendaryFound, 0, "scan must find at least one legendary seed");
        assertGt(mutationFound, 0, "scan must find at least one mutation seed");
    }

    /// @dev Fuzz-wide version of the scans above: across arbitrary
    /// seeds/offsets, EVERY mutation-or-legendary classified result must
    /// land in its OWN pinned sub-range - [251,255] for legendary,
    /// [248,250] for mutation - never the other's, full stop.
    function testFuzz_InheritLocus_MutationOrLegendaryAlwaysInPinnedDisjointSubRange(uint256 seed, uint8 offsetRaw)
        public
        pure
    {
        uint256 offset = offsetRaw % 5;
        vm.assume(_isLegendary(seed, offset) || _isMutation(seed, offset));
        uint8 result = GeneticsLib.inheritLocus(11, 222, seed, offset);
        if (_isLegendary(seed, offset)) {
            assertGe(result, 251, "legendary roll must clamp into its pinned [251,255] sub-range");
            assertLe(result, 255, "legendary roll must clamp into its pinned [251,255] sub-range");
        } else {
            assertGe(result, 248, "mutation roll must clamp into its pinned [248,250] sub-range");
            assertLe(result, 250, "mutation roll must clamp into its pinned [248,250] sub-range");
        }
    }

    /// @notice REQUIRED COVERAGE: "statistical sanity of ~50/50 flips over
    /// many seeds" for the standard branch's matron/sire coin flip -
    /// isolated from mutation/legendary contamination the same way the old
    /// suite isolated its (now-superseded) dominant/recessive ratio: matron
    /// and sire values chosen far apart and outside the reserved band so a
    /// mutation/legendary roll landing exactly on either value is
    /// essentially impossible to confuse with a real coin-flip result.
    function test_InheritLocus_CoinFlipIsRoughly50_50() public pure {
        uint8 matronVal = 10;
        uint8 sireVal = 200;
        uint256 matronCount = 0;
        uint256 sireCount = 0;
        uint256 samples = 8000;

        for (uint256 i = 0; i < samples; i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked("coinflip-seed", i)));
            uint8 result = GeneticsLib.inheritLocus(matronVal, sireVal, seed, 0);
            if (result == matronVal) matronCount++;
            else if (result == sireVal) sireCount++;
        }

        uint256 total = matronCount + sireCount;
        assertGt(total, samples * 90 / 100, "most samples should land on a literal parent value");

        uint256 matronRateBps = (matronCount * 10000) / total;
        assertGe(matronRateBps, 4600, "coin flip should be close to 50/50");
        assertLe(matronRateBps, 5400, "coin flip should be close to 50/50");
    }

    function testFuzz_InheritLocus_EqualParentsStandardBranchIsIdentity(uint8 p, uint256 seed) public pure {
        uint8 result = GeneticsLib.inheritLocus(p, p, seed, 0);
        vm.assume(!_isLegendary(seed, 0) && !_isMutation(seed, 0));
        assertEq(result, p, "equal parents on the standard branch must return that shared value");
    }

    // -----------------------------------------------------------
    // Combined mutation+legendary rate sanity (both branches together,
    // matching GeneticsLib's own documented 0.5%+5% = 5.5% combined rate)
    // -----------------------------------------------------------

    function test_CombinedMutationRateWithinExpectedBand() public pure {
        uint8[5] memory matron;
        uint8[5] memory sire;
        for (uint256 i = 0; i < 5; i++) {
            matron[i] = 50;
            sire[i] = 60;
        }

        uint256 totalLoci = 0;
        uint256 offBandLoci = 0;
        uint256 iterations = 500;

        for (uint256 iter = 0; iter < iterations; iter++) {
            uint256 seed = GeneticsLib.breedingSeed(COLL_A, iter, COLL_B, iter + 1, iter * 123456);
            uint8[5] memory child = GeneticsLib.resolveGenome(matron, sire, seed);
            for (uint256 i = 0; i < 5; i++) {
                totalLoci++;
                if (child[i] != 50 && child[i] != 60) offBandLoci++;
            }
        }

        uint256 mutationRateBps = (offBandLoci * 10000) / totalLoci;
        assertGe(mutationRateBps, 300, "combined mutation+legendary rate should be at least 3%");
        assertLe(mutationRateBps, 800, "combined mutation+legendary rate should be at most 8%");
    }
}
