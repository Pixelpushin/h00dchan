// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";

/// @notice Statistical + determinism coverage for GeneticsLib, ported and
/// extended from AquaPrimeGenetics.t.sol
/// (AQUAPRIME_RPG/foundry/src/test/AquaPrimeGenetics.t.sol). AquaPrime's
/// own suite only ever tested the COMBINED mutation rate (legendary + base
/// mutation together, 3-8% band via test_MutationRateIsWithinExpectedRange)
/// and never isolated the 60/40 dominant/recessive ratio or the legendary
/// rate on their own - both added here.
contract GeneticsLibTest is Test {
    // -----------------------------------------------------------
    // Determinism (mirrors AquaPrimeGenetics.t.sol's
    // test_BreedingIsDeterministic)
    // -----------------------------------------------------------

    function test_BreedingIsDeterministic() public pure {
        uint8[5] memory father = [uint8(10), 20, 30, 40, 50];
        uint8[5] memory mother = [uint8(200), 190, 180, 170, 160];
        uint256 seed = GeneticsLib.breedingSeed(1, 2, 3, bytes32(uint256(0xBEEF)));

        uint8[5] memory child1 = GeneticsLib.resolveGenome(father, mother, seed);
        uint8[5] memory child2 = GeneticsLib.resolveGenome(father, mother, seed);

        for (uint256 i = 0; i < 5; i++) {
            assertEq(child1[i], child2[i], "same seed must produce identical genome");
        }
    }

    function test_BreedingSeed_DifferentNonceDiffersSeed() public pure {
        bytes32 entropy = bytes32(uint256(0xBEEF));
        uint256 seedA = GeneticsLib.breedingSeed(1, 2, 0, entropy);
        uint256 seedB = GeneticsLib.breedingSeed(1, 2, 1, entropy);
        assertTrue(seedA != seedB, "different breedNonce must change the seed");
    }

    function test_BreedingSeed_DifferentEntropyDiffersSeed() public pure {
        // The whole point of the 4th param (see BreedingController's
        // SEED-FAIRNESS MITIGATION note): two commits identical in every
        // other way must still diverge if blockhash(commitBlock) differs.
        uint256 seedA = GeneticsLib.breedingSeed(1, 2, 3, bytes32(uint256(1)));
        uint256 seedB = GeneticsLib.breedingSeed(1, 2, 3, bytes32(uint256(2)));
        assertTrue(seedA != seedB, "different entropy must change the seed");
    }

    function test_BreedingSeed_MatchesSpecFormula() public pure {
        uint256 fatherTokenId = 42;
        uint256 motherTokenId = 7;
        uint256 breedNonce = 3;
        bytes32 entropy = bytes32(uint256(0xC0FFEE));
        uint256 expected = uint256(keccak256(abi.encodePacked(fatherTokenId, motherTokenId, breedNonce, entropy)));
        assertEq(GeneticsLib.breedingSeed(fatherTokenId, motherTokenId, breedNonce, entropy), expected);
    }

    // -----------------------------------------------------------
    // Isolated 60/40 dominant/recessive ratio (AquaPrime never
    // isolated this - it was always entangled with mutation/legendary
    // in the combined-rate test).
    //
    // p1=50, p2=100 chosen so dominant=100, recessive=50 are far apart:
    // - Standard branch (94.5% of loci) returns exactly 100 or 50.
    // - Mutation branch (5%) draws from lo + (mag % (range*3)) where
    //   range=50, so mag%150 in [0,149] -> value in [50,199] - can
    //   coincidentally equal 50 or 100 but usually doesn't.
    // - Legendary branch (0.5%) returns a uniformly random byte -
    //   ~1/256 chance of landing exactly on 50 or 100.
    // Over a large sample, contamination from the other two branches
    // landing exactly on 50 or 100 is small enough that the measured
    // dominant:recessive ratio among {50,100} results still isolates the
    // 60/40 split with a wide-but-meaningful tolerance band.
    // -----------------------------------------------------------
    function test_InheritLocus_DominantRecessiveRatioIsolated() public pure {
        uint8 p1 = 50;
        uint8 p2 = 100;
        uint256 dominantCount = 0;
        uint256 recessiveCount = 0;
        uint256 samples = 4000;

        for (uint256 i = 0; i < samples; i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked("ratio-seed", i)));
            uint8 result = GeneticsLib.inheritLocus(p1, p2, seed, 0);
            if (result == 100) dominantCount++;
            else if (result == 50) recessiveCount++;
        }

        uint256 total = dominantCount + recessiveCount;
        assertGt(total, samples * 90 / 100, "most samples should land on a parent value");

        uint256 dominantRatioBps = (dominantCount * 10000) / total;
        // Expected 6000 bps (60%). Wide tolerance (5200-6800) absorbs both
        // sampling noise and the small mutation/legendary contamination
        // described above.
        assertGe(dominantRatioBps, 5200, "dominant ratio should be near 60%");
        assertLe(dominantRatioBps, 6800, "dominant ratio should be near 60%");
    }

    // -----------------------------------------------------------
    // Isolated legendary mutation rate (~0.5%) - AquaPrime never
    // isolated this either.
    //
    // p1=p2=0 chosen so:
    // - Standard branch always returns exactly 0.
    // - Mutation branch: lo=0, hi=0, range=1 (the `range = hi > lo ? ... :
    //   1` fallback), so val = 0 + (mag % 3) in {0,1,2} - always <= 2.
    // - Legendary branch returns a uniformly random byte (0-255) - only
    //   ~3/256 (~1.2%) of legendary draws land in {0,1,2} and get missed
    //   by the ">2" filter below, so counting results >2 isolates the
    //   legendary branch specifically with only that small, known
    //   undercount.
    // -----------------------------------------------------------
    function test_InheritLocus_LegendaryRateIsolated() public pure {
        uint8 p1 = 0;
        uint8 p2 = 0;
        uint256 clearlyLegendary = 0;
        uint256 samples = 40000;

        for (uint256 i = 0; i < samples; i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked("legendary-seed", i)));
            uint8 result = GeneticsLib.inheritLocus(p1, p2, seed, 0);
            if (result > 2) clearlyLegendary++;
        }

        uint256 rateBps = (clearlyLegendary * 10000) / samples;
        // True rate is 50 bps (0.5%), undercounted by ~1.2% of legendary
        // draws landing in {0,1,2} -> expect roughly 49 bps measured.
        // Tolerance: 20-90 bps comfortably contains that plus sampling
        // noise at 40k samples.
        assertGe(rateBps, 20, "legendary rate should be roughly 0.5%");
        assertLe(rateBps, 90, "legendary rate should be roughly 0.5%");
    }

    // -----------------------------------------------------------
    // Combined mutation rate (~5.5% = 5% base + 0.5% legendary) - mirrors
    // AquaPrimeGenetics.t.sol's test_MutationRateIsWithinExpectedRange
    // exactly (same p1/p2 = 50/60, same 3-8% (300-800 bps) tolerance
    // band, same "not equal to either parent value" detection method),
    // ported from AquaPrime's 6-visual-gene/250-iteration loop to
    // GeneticsLib's flat 5-slot genome.
    // -----------------------------------------------------------
    function test_CombinedMutationRateWithinExpectedBand() public pure {
        uint8[5] memory father;
        uint8[5] memory mother;
        for (uint256 i = 0; i < 5; i++) {
            father[i] = 50;
            mother[i] = 60;
        }

        uint256 totalLoci = 0;
        uint256 mutatedLoci = 0;
        uint256 iterations = 500;

        for (uint256 iter = 0; iter < iterations; iter++) {
            uint256 seed = GeneticsLib.breedingSeed(iter, iter + 1, iter * 123456, keccak256(abi.encodePacked(iter)));
            uint8[5] memory child = GeneticsLib.resolveGenome(father, mother, seed);
            for (uint256 i = 0; i < 5; i++) {
                totalLoci++;
                if (child[i] != 50 && child[i] != 60) mutatedLoci++;
            }
        }

        uint256 mutationRateBps = (mutatedLoci * 10000) / totalLoci;
        assertGe(mutationRateBps, 300, "combined mutation rate should be at least 3%");
        assertLe(mutationRateBps, 800, "combined mutation rate should be at most 8%");
    }

    // -----------------------------------------------------------
    // Sanity checks
    // -----------------------------------------------------------

    function test_ResolveGenome_SlotsAreIndependent() public pure {
        uint8[5] memory father = [uint8(1), 2, 3, 4, 5];
        uint8[5] memory mother = [uint8(250), 249, 248, 247, 246];
        uint256 seed = GeneticsLib.breedingSeed(10, 20, 30, bytes32(uint256(0xABCD)));

        uint8[5] memory genome = GeneticsLib.resolveGenome(father, mother, seed);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(genome[i], GeneticsLib.inheritLocus(father[i], mother[i], seed, i), "slot must use offset==slot index");
        }
    }

    function testFuzz_InheritLocus_NeverReverts(uint8 p1, uint8 p2, uint256 seed, uint256 offset) public pure {
        GeneticsLib.inheritLocus(p1, p2, seed, offset);
    }

    function testFuzz_InheritLocus_EqualParentsStandardBranchIsIdentity(uint8 p, uint256 seed) public pure {
        // When p1==p2, the standard branch (94.5% of the time) must
        // return p regardless of the dominant/recessive coin flip, since
        // dominant==recessive==p in that case.
        uint8 result = GeneticsLib.inheritLocus(p, p, seed, 0);
        uint256 locusSeed = uint256(keccak256(abi.encodePacked(seed, uint256(0))));
        bool isLegendary = (locusSeed % 10000) < 50;
        bool isMutation = !isLegendary && (((locusSeed >> 16) % 10000) < 500);
        if (!isLegendary && !isMutation) {
            assertEq(result, p, "equal parents on the standard branch must return that value");
        }
    }
}
