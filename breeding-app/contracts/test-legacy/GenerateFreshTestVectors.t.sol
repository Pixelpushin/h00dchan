// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";

/// @notice Independent staleness guard for the TS-parity task, separate
/// from GenerateTestVectors.t.sol / test-vectors.json. Deliberately uses a
/// different token-ID range, a different gene formula, a different
/// breedNonce stride, and a different entropy derivation than the primary
/// fixture generator so a TS implementation that was overfit/hardcoded to
/// the primary fixture's specific numbers (rather than actually
/// re-implementing GeneticsLib's arithmetic) still gets caught here. Uses
/// the same FINAL 4-arg breedingSeed signature (fatherTokenId,
/// motherTokenId, breedNonce, entropy) as GenerateTestVectors.t.sol - see
/// GeneticsLib.breedingSeed and BreedingController's SEED-FAIRNESS
/// MITIGATION note. Writes breeding-app/contracts/test-vectors-fresh.json,
/// committed alongside test-vectors.json.
contract GenerateFreshTestVectorsTest is Test {
    struct Vector {
        uint256 fatherTokenId;
        uint256 motherTokenId;
        uint256 breedNonce;
        bytes32 entropy;
        uint8[5] fatherGenes;
        uint8[5] motherGenes;
    }

    uint256 internal constant MIN_VECTORS = 100;

    function test_WriteFreshTestVectors() public {
        Vector[] memory vectors = _buildVectors();

        // vm.writeLine (append-only) rather than accumulated string.concat
        // - see GenerateTestVectors.t.sol's header comment on why: repeated
        // string.concat over a large in-memory blob is O(n^2) and reliably
        // blows the EVM's memory limit well before the loop ends.
        vm.writeFile("test-vectors-fresh.json", "[\n");

        for (uint256 i = 0; i < vectors.length; i++) {
            Vector memory v = vectors[i];
            uint256 seed = GeneticsLib.breedingSeed(v.fatherTokenId, v.motherTokenId, v.breedNonce, v.entropy);
            uint8[5] memory genome = GeneticsLib.resolveGenome(v.fatherGenes, v.motherGenes, seed);

            string memory line = string.concat(
                "{",
                '"fatherTokenId":',
                vm.toString(v.fatherTokenId),
                ',"motherTokenId":',
                vm.toString(v.motherTokenId),
                ',"breedNonce":',
                vm.toString(v.breedNonce),
                ',"entropy":"',
                vm.toString(v.entropy),
                '"'
            );
            line = string.concat(
                line,
                ',"fatherGenes":',
                _arrJson(v.fatherGenes),
                ',"motherGenes":',
                _arrJson(v.motherGenes),
                ',"expectedSeed":"',
                vm.toString(seed),
                '","expectedGenome":',
                _arrJson(genome),
                i == vectors.length - 1 ? "}" : "},"
            );
            vm.writeLine("test-vectors-fresh.json", line);
        }

        vm.writeLine("test-vectors-fresh.json", "]");

        // Guards against a future refactor silently shrinking coverage
        // below this secondary fixture's floor.
        assertGe(vectors.length, MIN_VECTORS, "must emit at least MIN_VECTORS fresh test vectors");
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
    /// purpose (see contract header): token IDs start at 10000+/20000+,
    /// gene formula uses different multipliers/offsets and prime moduli,
    /// breedNonce is offset by 5_000_000 rather than starting at 0, and
    /// entropy is derived from a differently-salted keccak256. 12 fathers x
    /// 10 mothers = 120 base combinations, plus edge cases.
    function _buildVectors() internal pure returns (Vector[] memory vectors) {
        uint256 fCount = 12;
        uint256 mCount = 10;
        uint256 edgeCases = 6;
        vectors = new Vector[](fCount * mCount + edgeCases);
        uint256 idx = 0;

        for (uint256 f = 0; f < fCount; f++) {
            for (uint256 m = 0; m < mCount; m++) {
                uint8[5] memory fatherGenes;
                uint8[5] memory motherGenes;
                for (uint256 k = 0; k < 5; k++) {
                    fatherGenes[k] = uint8((f * 61 + k * 23 + 7) % 256);
                    motherGenes[k] = uint8((m * 71 + k * 29 + 5) % 256);
                }
                vectors[idx] = Vector({
                    fatherTokenId: 10000 + f * 3 + 1,
                    motherTokenId: 20000 + m * 7 + 1,
                    breedNonce: 5_000_000 + idx * 2,
                    entropy: keccak256(abi.encodePacked("fresh-entropy", f, m)),
                    fatherGenes: fatherGenes,
                    motherGenes: motherGenes
                });
                idx++;
            }
        }

        // Edge cases distinct from the primary fixture's.
        vectors[idx++] = Vector({
            fatherTokenId: 99999,
            motherTokenId: 1,
            breedNonce: 0,
            entropy: bytes32(0),
            fatherGenes: [uint8(0), 255, 0, 255, 0],
            motherGenes: [uint8(255), 0, 255, 0, 255]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 2,
            motherTokenId: 2,
            breedNonce: type(uint32).max,
            entropy: bytes32(type(uint256).max),
            fatherGenes: [uint8(128), 128, 128, 128, 128],
            motherGenes: [uint8(128), 128, 128, 128, 128]
        });
        vectors[idx++] = Vector({
            fatherTokenId: type(uint32).max,
            motherTokenId: type(uint32).max,
            breedNonce: 42,
            entropy: keccak256("fresh-edge-max32"),
            fatherGenes: [uint8(17), 34, 51, 68, 85],
            motherGenes: [uint8(240), 223, 206, 189, 172]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 555,
            motherTokenId: 444,
            breedNonce: 1,
            entropy: keccak256("fresh-edge-555-444"),
            fatherGenes: [uint8(1), 2, 3, 4, 5],
            motherGenes: [uint8(254), 253, 252, 251, 250]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 8,
            motherTokenId: 9,
            breedNonce: 777777,
            entropy: keccak256("fresh-edge-8-9"),
            fatherGenes: [uint8(100), 100, 100, 100, 100],
            motherGenes: [uint8(101), 99, 200, 5, 150]
        });
        // Same father/mother/nonce as the FIRST edge case above, only
        // entropy differs - mirrors GenerateTestVectors.t.sol's same check
        // for the commit/reveal fix, using this file's own distinct salt.
        vectors[idx++] = Vector({
            fatherTokenId: 99999,
            motherTokenId: 1,
            breedNonce: 0,
            entropy: keccak256("fresh-distinct-entropy"),
            fatherGenes: [uint8(0), 255, 0, 255, 0],
            motherGenes: [uint8(255), 0, 255, 0, 255]
        });
    }
}
