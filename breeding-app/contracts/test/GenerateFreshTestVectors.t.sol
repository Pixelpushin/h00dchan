// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";

/// @notice Independent staleness guard for the TS-parity task, separate
/// from GenerateTestVectors.t.sol / test-vectors.json. Deliberately uses a
/// different token-id range, a different gene formula, a different nonce
/// stride, a different stand-in collection address set, and a different
/// fee-vector grid (different birthFee/listedFee lists and a different
/// sameSexFeeMultiplier) than the primary fixture generator, so a TS
/// implementation that was overfit/hardcoded to the primary fixture's
/// specific numbers (rather than actually re-implementing GeneticsLib's
/// arithmetic and BreedingController's fee formulas) still gets caught
/// here. Writes breeding-app/contracts/test-vectors-fresh.json, committed
/// alongside test-vectors.json. See GenerateTestVectors.t.sol's header for
/// the shared v1->v2 rewrite rationale (5-arg entropy-free breedingSeed,
/// matron/sire COLLECTION addresses, dropped `entropy` field, added `fees`
/// section) - not repeated here.
contract GenerateFreshTestVectorsTest is Test {
    struct GeneticsVector {
        address matronCollection;
        uint256 matronId;
        address sireCollection;
        uint256 sireId;
        uint256 nonce;
        uint8[5] matronGenes;
        uint8[5] sireGenes;
        bool matronSex;
        bool sireSex;
    }

    struct FeeVector {
        uint256 birthFee;
        uint256 sameSexFeeMultiplier;
        bool sameSex;
        bool selfSiring;
        uint256 listedFee;
    }

    uint256 internal constant MIN_GENETICS_VECTORS = 100;
    uint256 internal constant MIN_FEE_VECTORS = 40;

    // Distinct from GenerateTestVectors.t.sol's COLL_HOODCHAN/GIRLFRIEND/BABY
    // addresses on purpose (see contract header).
    address internal constant COLL_A = address(0x4444444444444444444444444444444444444444);
    address internal constant COLL_B = address(0x5555555555555555555555555555555555555555);
    address internal constant COLL_C = address(0x6666666666666666666666666666666666666666);

    function test_WriteFreshTestVectors() public {
        GeneticsVector[] memory geneticsVectors = _buildGeneticsVectors();
        FeeVector[] memory feeVectors = _buildFeeVectors();

        vm.writeFile("test-vectors-fresh.json", "{\n\"genetics\":[\n");
        _writeGenetics("test-vectors-fresh.json", geneticsVectors);
        vm.writeLine("test-vectors-fresh.json", "],\n\"fees\":[\n");
        _writeFees("test-vectors-fresh.json", feeVectors);
        vm.writeLine("test-vectors-fresh.json", "]\n}");

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

    /// @dev Distinct formula/range from GenerateTestVectors.t.sol on
    /// purpose (see contract header): token ids start at 10000+/20000+,
    /// gene formula uses different multipliers/offsets and prime moduli,
    /// nonce is offset by 5_000_000 rather than starting at 0. 12 matron
    /// variants x 10 sire variants = 120 base combinations, plus edge
    /// cases.
    function _buildGeneticsVectors() internal pure returns (GeneticsVector[] memory vectors) {
        address[3] memory collections = [COLL_A, COLL_B, COLL_C];
        uint256 mCount = 12;
        uint256 sCount = 10;
        uint256 edgeCases = 8;
        vectors = new GeneticsVector[](mCount * sCount + edgeCases);
        uint256 idx = 0;

        for (uint256 f = 0; f < mCount; f++) {
            for (uint256 m = 0; m < sCount; m++) {
                uint8[5] memory matronGenes;
                uint8[5] memory sireGenes;
                for (uint256 k = 0; k < 5; k++) {
                    matronGenes[k] = uint8((f * 61 + k * 23 + 7) % 256);
                    sireGenes[k] = uint8((m * 71 + k * 29 + 5) % 256);
                }
                vectors[idx] = GeneticsVector({
                    matronCollection: collections[(f + 2) % 3],
                    matronId: 10000 + f * 3 + 1,
                    sireCollection: collections[m % 3],
                    sireId: 20000 + m * 7 + 1,
                    nonce: 5_000_000 + idx * 2,
                    matronGenes: matronGenes,
                    sireGenes: sireGenes,
                    matronSex: f % 3 != 0,
                    sireSex: m % 3 != 0
                });
                idx++;
            }
        }

        // Edge cases distinct from the primary fixture's.
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_C,
            matronId: 99999,
            sireCollection: COLL_A,
            sireId: 1,
            nonce: 0,
            matronGenes: [uint8(0), 255, 0, 255, 0],
            sireGenes: [uint8(255), 0, 255, 0, 255],
            matronSex: false,
            sireSex: false
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_B,
            matronId: 2,
            sireCollection: COLL_B,
            sireId: 2,
            nonce: type(uint32).max,
            matronGenes: [uint8(128), 128, 128, 128, 128],
            sireGenes: [uint8(128), 128, 128, 128, 128],
            matronSex: true,
            sireSex: true
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_A,
            matronId: type(uint32).max,
            sireCollection: COLL_C,
            sireId: type(uint32).max,
            nonce: 42,
            matronGenes: [uint8(17), 34, 51, 68, 85],
            sireGenes: [uint8(240), 223, 206, 189, 172],
            matronSex: true,
            sireSex: false
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_C,
            matronId: 555,
            sireCollection: COLL_B,
            sireId: 444,
            nonce: 1,
            matronGenes: [uint8(1), 2, 3, 4, 5],
            sireGenes: [uint8(254), 253, 252, 251, 250],
            matronSex: false,
            sireSex: true
        });
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_A,
            matronId: 8,
            sireCollection: COLL_A,
            sireId: 9,
            nonce: 777777,
            matronGenes: [uint8(100), 100, 100, 100, 100],
            sireGenes: [uint8(101), 99, 200, 5, 150],
            matronSex: true,
            sireSex: true
        });
        // Identical parents at the library level (distinct from the
        // primary fixture's own identical-parents case).
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_B,
            matronId: 321,
            sireCollection: COLL_B,
            sireId: 321,
            nonce: 8,
            matronGenes: [uint8(77), 88, 99, 110, 121],
            sireGenes: [uint8(77), 88, 99, 110, 121],
            matronSex: false,
            sireSex: false
        });
        // Same-inputs-except-one-field pair, this fixture's own salt -
        // only `nonce` differs from the case immediately above's sibling
        // (id 99999/1) but is otherwise identical.
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_C,
            matronId: 99999,
            sireCollection: COLL_A,
            sireId: 1,
            nonce: 123,
            matronGenes: [uint8(0), 255, 0, 255, 0],
            sireGenes: [uint8(255), 0, 255, 0, 255],
            matronSex: false,
            sireSex: false
        });
        // Matron/sire role swap - same ids, same collections, roles
        // reversed (this fixture's own instance of the v2-only case).
        vectors[idx++] = GeneticsVector({
            matronCollection: COLL_A,
            matronId: 1,
            sireCollection: COLL_C,
            sireId: 99999,
            nonce: 123,
            matronGenes: [uint8(255), 0, 255, 0, 255],
            sireGenes: [uint8(0), 255, 0, 255, 0],
            matronSex: false,
            sireSex: false
        });
    }

    // ---------------------------------------------------------------
    // Fees section - same formula as GenerateTestVectors.t.sol (mirrors
    // BreedingController._collectBirthFee/_collectSiringFee exactly - see
    // that file's header), different input grid.
    // ---------------------------------------------------------------

    function _writeFees(string memory path, FeeVector[] memory vectors) internal {
        for (uint256 i = 0; i < vectors.length; i++) {
            FeeVector memory v = vectors[i];

            uint256 birthFeePaid = v.sameSex ? v.birthFee * v.sameSexFeeMultiplier : v.birthFee;
            uint256 siringPrice = v.selfSiring ? 0 : v.listedFee;
            uint256 burnAmount = (siringPrice * 500) / 10000;
            uint256 multisigAmount = (siringPrice * 300) / 10000;
            uint256 sireOwnerAmount = siringPrice;
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

    /// @dev Different grid from GenerateTestVectors.t.sol: 2 birthFee
    /// levels x a differently-salted dust-heavy listedFee list x sameSex x
    /// selfSiring = 2*11*2*2 = 88, and a different sameSexFeeMultiplier (3,
    /// not 2) so a TS port hardcoded to the primary fixture's multiplier
    /// value alone would still be caught.
    function _buildFeeVectors() internal pure returns (FeeVector[] memory vectors) {
        uint256[2] memory birthFees = [uint256(1 ether), 250 ether];
        uint256 sameSexMultiplier = 3;
        uint256[11] memory listedFees = [
            uint256(0),
            1,
            4,
            9,
            17,
            29,
            41,
            123,
            4567,
            50 ether,
            777777 ether
        ];

        vectors = new FeeVector[](2 * 11 * 2 * 2);
        uint256 idx = 0;
        for (uint256 b = 0; b < 2; b++) {
            for (uint256 l = 0; l < 11; l++) {
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
