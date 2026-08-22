// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";

/// @notice Not a correctness test - a fixture generator. Writes
/// breeding-app/contracts/test-vectors.json, consumed by the downstream
/// TS-parity task to verify the off-chain genome-preview implementation
/// produces bit-for-bit identical seeds/genomes/fee breakdowns to this
/// Solidity code. Runs as part of `forge test` (green run == file written
/// successfully) rather than a separate `forge script` invocation, so
/// CI/local runs can't forget to regenerate it.
///
/// v2 REWRITE (docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md):
/// the old fixture (test-legacy/GenerateTestVectors.t.sol) used a 4-arg
/// `breedingSeed(fatherTokenId, motherTokenId, breedNonce, entropy)` fed by
/// the now-deleted commit/reveal seed-hiding scheme. The new signature is
/// 5-arg and entropy-free: `breedingSeed(matronCollection, matronId,
/// sireCollection, sireId, nonce)` - roles now span THREE symmetric
/// collections (any collection can be matron OR sire), so every vector
/// carries a matron/sire COLLECTION address alongside its token id. The
/// dead `entropy` field is dropped entirely, not renamed.
///
/// Two top-level sections in the one output file:
///   "genetics" - seed/genome/babySex/isTestTubeBaby vectors (GeneticsLib
///                 is a pure library, so these are exact 1:1 calls).
///   "fees"      - birth-fee/siring-fee-split vectors. BreedingController's
///                 fee math (_collectBirthFee/_collectSiringFee) isn't
///                 exposed as a pure library function, so this section
///                 mirrors that arithmetic verbatim (documented inline,
///                 kept intentionally trivial - flat multiplication and two
///                 independent floor divisions) rather than deploying the
///                 full contract; BreedingController.t.sol's fee tests
///                 separately verify the REAL contract produces byte-exact
///                 matching balances for the same numbers, so this fixture
///                 is cross-checked against live contract behavior, not
///                 just self-consistent.
contract GenerateTestVectorsTest is Test {
    struct GeneticsVector {
        address matronCollection;
        uint256 matronId;
        address sireCollection;
        uint256 sireId;
        uint256 nonce;
        uint8[5] matronGenes;
        uint8[5] sireGenes;
        bool matronSex; // true = Male
        bool sireSex;
    }

    struct FeeVector {
        uint256 birthFee;
        uint256 sameSexFeeMultiplier;
        bool sameSex;
        bool selfSiring;
        uint256 listedFee;
    }

    /// @dev Spec floor is ">= 50"; the v1->v2 rewrite (cross-collection
    /// matron/sire roles) doesn't shrink the required density, so this
    /// generator keeps the prior attempt's already-expanded >= 500 floor.
    uint256 internal constant MIN_GENETICS_VECTORS = 500;
    uint256 internal constant MIN_FEE_VECTORS = 100;

    // Stand-in addresses for the three real collections - this generator
    // only exercises the PURE math (GeneticsLib / fee formulas), so these
    // never need to resolve to deployed contracts, only to be distinct,
    // stable values the TS port can echo back verbatim.
    address internal constant COLL_HOODCHAN = address(0x1111111111111111111111111111111111111111);
    address internal constant COLL_GIRLFRIEND = address(0x2222222222222222222222222222222222222222);
    address internal constant COLL_BABY = address(0x3333333333333333333333333333333333333333);

    function test_WriteTestVectors() public {
        GeneticsVector[] memory geneticsVectors = _buildGeneticsVectors();
        FeeVector[] memory feeVectors = _buildFeeVectors();

        // vm.writeLine (append-only, one syscall per vector) rather than
        // accumulated string.concat - see this file's prior attempt's
        // header comment for why: repeated string.concat over a large
        // in-memory blob is O(n^2) in both memory-expansion gas and heap
        // churn, and reliably blows the EVM's memory limit well before the
        // loop ends for 500+ vectors. Appending each vector as its own line
        // to disk keeps this O(n).
        vm.writeFile("test-vectors.json", "{\n\"genetics\":[\n");
        _writeGenetics("test-vectors.json", geneticsVectors);
        vm.writeLine("test-vectors.json", "],\n\"fees\":[\n");
        _writeFees("test-vectors.json", feeVectors);
        vm.writeLine("test-vectors.json", "]\n}");

        // Guards against a future refactor silently shrinking coverage
        // below the floor.
        assertGe(geneticsVectors.length, MIN_GENETICS_VECTORS, "must emit at least MIN_GENETICS_VECTORS vectors");
        assertGe(feeVectors.length, MIN_FEE_VECTORS, "must emit at least MIN_FEE_VECTORS fee vectors");
    }

    // ---------------------------------------------------------------
    // Genetics section
    // ---------------------------------------------------------------

    function _writeGenetics(string memory path, GeneticsVector[] memory vectors) internal {
        for (uint256 i = 0; i < vectors.length; i++) {
            GeneticsVector memory v = vectors[i];
            uint256 seed = GeneticsLib.breedingSeed(v.matronCollection, v.matronId, v.sireCollection, v.sireId, v.nonce);
            uint8[5] memory genome = GeneticsLib.resolveGenome(v.matronGenes, v.sireGenes, seed);
            bool babyIsMale = GeneticsLib.resolveBabyIsMale(seed);
            bool isTestTubeBaby = v.matronSex == v.sireSex;

            string memory line = string.concat(
                "{",
                '"matronCollection":"',
                vm.toString(v.matronCollection),
                '","matronId":',
                vm.toString(v.matronId),
                ',"sireCollection":"',
                vm.toString(v.sireCollection),
                '","sireId":',
                vm.toString(v.sireId),
                ',"nonce":',
                vm.toString(v.nonce)
            );
            line = string.concat(
                line,
                ',"matronGenes":',
                _arrJson(v.matronGenes),
                ',"sireGenes":',
                _arrJson(v.sireGenes),
                ',"matronSex":',
                v.matronSex ? "true" : "false",
                ',"sireSex":',
                v.sireSex ? "true" : "false"
            );
            line = string.concat(
                line,
                ',"expectedSeed":"',
                vm.toString(seed),
                '","expectedGenome":',
                _arrJson(genome),
                ',"expectedBabyIsMale":',
                babyIsMale ? "true" : "false",
                ',"expectedIsTestTubeBaby":',
                isTestTubeBaby ? "true" : "false",
                i == vectors.length - 1 ? "}" : "},"
            );
            vm.writeLine(path, line);
        }
    }

    function _arrJson(uint8[5] memory arr) internal pure returns (string memory) {
        return string.concat(
            "[",
            vm.toString(uint256(arr[0])),
            ",",
            vm.toString(uint256(arr[1])),
            ",",
            vm.toString(uint256(arr[2])),
            ",",
            vm.toString(uint256(arr[3])),
            ",",
            vm.toString(uint256(arr[4])),
            "]"
        );
    }

    /// @dev Deterministic, code-generated grid (not hand-picked) - 10
    /// matron variants x 5 sire variants x 10 nonce variants = 500 base
    /// combinations, cycling matron/sire through all THREE stand-in
    /// collection addresses (the v2 spec's "any collection, either role"
    /// symmetry) via modulo, each with genes derived from a simple
    /// non-random formula, plus explicit hand-picked edge cases appended on
    /// top for a healthy margin over MIN_GENETICS_VECTORS.
    function _buildGeneticsVectors() internal pure returns (GeneticsVector[] memory vectors) {
        address[3] memory collections = [COLL_HOODCHAN, COLL_GIRLFRIEND, COLL_BABY];
        uint256 edgeCases = 9;
        vectors = new GeneticsVector[](10 * 5 * 10 + edgeCases);
        uint256 idx = 0;

        for (uint256 f = 0; f < 10; f++) {
            for (uint256 m = 0; m < 5; m++) {
                uint8[5] memory matronGenes;
                uint8[5] memory sireGenes;
                for (uint256 k = 0; k < 5; k++) {
                    matronGenes[k] = uint8((f * 37 + k * 11 + 3) % 256);
                    sireGenes[k] = uint8((m * 53 + k * 17 + 200) % 256);
                }
                for (uint256 n = 0; n < 10; n++) {
                    vectors[idx] = GeneticsVector({
                        matronCollection: collections[f % 3],
                        matronId: f + 1,
                        sireCollection: collections[(m + 1) % 3],
                        sireId: m + 1,
                        nonce: idx,
                        matronGenes: matronGenes,
                        sireGenes: sireGenes,
                        matronSex: f % 2 == 0,
                        sireSex: m % 2 == 0
                    });
                    idx++;
                }
            }
        }

        // Edge cases.
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_GIRLFRIEND,
            matronId: 0,
            sireCollection: COLL_HOODCHAN,
            sireId: 0,
            nonce: 0,
            matronGenes: [uint8(0), 0, 0, 0, 0],
            sireGenes: [uint8(0), 0, 0, 0, 0],
            matronSex: false,
            sireSex: true
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_BABY,
            matronId: 1,
            sireCollection: COLL_BABY,
            sireId: 2,
            nonce: 999,
            matronGenes: [uint8(255), 255, 255, 255, 255],
            sireGenes: [uint8(255), 255, 255, 255, 255],
            matronSex: true,
            sireSex: false
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_HOODCHAN,
            matronId: 1200,
            sireCollection: COLL_GIRLFRIEND,
            sireId: 12,
            nonce: 1,
            matronGenes: [uint8(0), 0, 0, 0, 0],
            sireGenes: [uint8(255), 255, 255, 255, 255],
            matronSex: true,
            sireSex: false
        });
        // Identical parents (same genes AND same collection+id) - a
        // library-level edge case; BreedingController itself would revert
        // this exact combination via SameToken, but GeneticsLib's pure math
        // has no such restriction and must still be exercised here.
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_GIRLFRIEND,
            matronId: 531,
            sireCollection: COLL_GIRLFRIEND,
            sireId: 531,
            nonce: 2,
            matronGenes: [uint8(1), 100, 200, 50, 150],
            sireGenes: [uint8(1), 100, 200, 50, 150],
            matronSex: false,
            sireSex: false
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_HOODCHAN,
            matronId: 777,
            sireCollection: COLL_BABY,
            sireId: 12,
            nonce: 123456789,
            matronGenes: [uint8(42), 88, 133, 210, 7],
            sireGenes: [uint8(9), 99, 189, 240, 3],
            matronSex: true,
            sireSex: true
        });
        // Huge token ids - well past any realistic HOODCHAN/Girlfriends/
        // Babies supply, to catch any accidental narrowing in a TS port
        // (e.g. treating tokenId as a JS `number`).
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_HOODCHAN,
            matronId: type(uint128).max,
            sireCollection: COLL_GIRLFRIEND,
            sireId: type(uint64).max,
            nonce: type(uint32).max,
            matronGenes: [uint8(17), 34, 51, 68, 85],
            sireGenes: [uint8(240), 223, 206, 189, 172],
            matronSex: true,
            sireSex: false
        });
        // Same-inputs-except-one-field pair #1: only `nonce` differs from
        // the next vector - the whole point of nonce being part of the
        // seed (global monotonic counter, not per-token) is that this must
        // still resolve to a different seed/genome.
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_GIRLFRIEND,
            matronId: 1,
            sireCollection: COLL_HOODCHAN,
            sireId: 1,
            nonce: 0,
            matronGenes: [uint8(10), 20, 30, 40, 50],
            sireGenes: [uint8(60), 70, 80, 90, 100],
            matronSex: false,
            sireSex: true
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_GIRLFRIEND,
            matronId: 1,
            sireCollection: COLL_HOODCHAN,
            sireId: 1,
            nonce: 1,
            matronGenes: [uint8(10), 20, 30, 40, 50],
            sireGenes: [uint8(60), 70, 80, 90, 100],
            matronSex: false,
            sireSex: true
        });
        // Same-inputs-except-one-field pair #2: matron/sire ROLE SWAP at
        // otherwise-identical ids - only possible to even express in the
        // v2 "any collection, either role" design, so this pair has no v1
        // analogue at all.
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_BABY,
            matronId: 5,
            sireCollection: COLL_HOODCHAN,
            sireId: 5,
            nonce: 42,
            matronGenes: [uint8(3), 6, 9, 12, 15],
            sireGenes: [uint8(248), 249, 250, 251, 252],
            matronSex: false,
            sireSex: true
        });
    }

    // ---------------------------------------------------------------
    // Fees section - mirrors BreedingController._collectBirthFee /
    // _collectSiringFee's arithmetic exactly (see contract header comment).
    // ---------------------------------------------------------------

    function _writeFees(string memory path, FeeVector[] memory vectors) internal {
        for (uint256 i = 0; i < vectors.length; i++) {
            FeeVector memory v = vectors[i];

            uint256 birthFeePaid = v.sameSex ? v.birthFee * v.sameSexFeeMultiplier : v.birthFee;
            // Self-siring: `_collectSiringFee` is never even called by
            // BreedingController.breed() in this case - mirrored here as
            // siringPrice forced to 0, which yields identical (zero) parts.
            uint256 siringPrice = v.selfSiring ? 0 : v.listedFee;
            uint256 burnAmount = (siringPrice * 500) / 10000; // 5%, floors independently
            uint256 multisigAmount = (siringPrice * 300) / 10000; // 3%, floors independently
            uint256 sireOwnerAmount = siringPrice; // sire owner always gets exactly 100% of listedFee
            uint256 totalCallerDebit = birthFeePaid + sireOwnerAmount + burnAmount + multisigAmount;

            string memory line = string.concat(
                "{",
                '"birthFee":"',
                vm.toString(v.birthFee),
                '","sameSexFeeMultiplier":"',
                vm.toString(v.sameSexFeeMultiplier),
                '","sameSex":',
                v.sameSex ? "true" : "false",
                ',"selfSiring":',
                v.selfSiring ? "true" : "false",
                ',"listedFee":"',
                vm.toString(v.listedFee),
                '"'
            );
            line = string.concat(
                line,
                ',"expectedBirthFeePaid":"',
                vm.toString(birthFeePaid),
                '","expectedSireOwnerAmount":"',
                vm.toString(sireOwnerAmount),
                '","expectedBurnAmount":"',
                vm.toString(burnAmount),
                '","expectedMultisigAmount":"',
                vm.toString(multisigAmount),
                '","expectedTotalCallerDebit":"',
                vm.toString(totalCallerDebit),
                '"',
                i == vectors.length - 1 ? "}" : "},"
            );
            vm.writeLine(path, line);
        }
    }

    /// @dev Formulaic grid over 3 birthFee levels x a deliberately
    /// dust-heavy listedFee list (chosen to exercise the 5%/3% floor
    /// division's truncation behavior at small values, not just clean
    /// round numbers) x sameSex x selfSiring = 3*17*2*2 = 204 combinations.
    function _buildFeeVectors() internal pure returns (FeeVector[] memory vectors) {
        uint256[3] memory birthFees = [uint256(0), 100 ether, 37 ether];
        uint256 sameSexMultiplier = 2;
        uint256[17] memory listedFees = [
            uint256(0),
            1,
            2,
            3,
            7,
            13,
            37,
            99,
            100,
            999,
            1000,
            10000,
            1 ether,
            100 ether,
            12345 ether,
            999999999999999999,
            1_000_000 ether
        ];

        vectors = new FeeVector[](3 * 17 * 2 * 2);
        uint256 idx = 0;
        for (uint256 b = 0; b < 3; b++) {
            for (uint256 l = 0; l < 17; l++) {
                for (uint256 s = 0; s < 2; s++) {
                    for (uint256 f = 0; f < 2; f++) {
                        vectors[idx++] = FeeVector({
                            birthFee: birthFees[b],
                            sameSexFeeMultiplier: sameSexMultiplier,
                            sameSex: s == 1,
                            selfSiring: f == 1,
                            listedFee: listedFees[l]
                        });
                    }
                }
            }
        }
    }
}
