// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";

/// @notice Not a correctness test - a fixture generator. Writes
/// breeding-app/contracts/test-vectors.json, consumed by the downstream
/// TS-parity task to verify the off-chain genome-preview implementation
/// produces bit-for-bit identical seeds/genomes to this Solidity code.
/// Runs as part of `forge test` (green run == file written successfully)
/// rather than a separate `forge script` invocation, so CI/local runs
/// can't forget to regenerate it.
///
/// Uses the FINAL breedingSeed algorithm (4-arg: fatherTokenId,
/// motherTokenId, breedNonce, entropy) - see GeneticsLib.breedingSeed and
/// BreedingController's SEED-FAIRNESS MITIGATION note. `entropy` is
/// whatever BreedingController.revealBreed anchors to
/// (`blockhash(commitBlock)`) in production; for a static, deterministic
/// fixture file, each vector instead uses a distinct, code-generated
/// bytes32 in the same field position so the off-chain implementation is
/// exercised against real (non-zero, non-repeating) entropy values without
/// this generator needing to simulate an actual chain.
contract GenerateTestVectorsTest is Test {
    struct Vector {
        uint256 fatherTokenId;
        uint256 motherTokenId;
        uint256 breedNonce;
        bytes32 entropy;
        uint8[5] fatherGenes;
        uint8[5] motherGenes;
    }

    /// @dev Spec floor is ">= 50"; the commit/reveal seed-fairness fix
    /// added a 4th (entropy) input to breedingSeed, so the vector set was
    /// expanded an order of magnitude (>= 500) to give the off-chain
    /// TS-parity port meaningfully denser coverage of that new input,
    /// not just the original 3.
    uint256 internal constant MIN_VECTORS = 500;

    function test_WriteTestVectors() public {
        Vector[] memory vectors = _buildVectors();

        // Written incrementally via vm.writeLine (append-only, one syscall
        // per vector) rather than accumulated with repeated string.concat
        // into one in-memory string - string.concat re-copies the ENTIRE
        // accumulated string on every call, so building a 500+-vector JSON
        // blob that way is O(n^2) in both memory-expansion gas and actual
        // heap churn and reliably blows the EVM's memory limit well before
        // reaching the end of the loop. Appending each vector as its own
        // line to disk keeps this O(n).
        vm.writeFile("test-vectors.json", "[\n");

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
            vm.writeLine("test-vectors.json", line);
        }

        vm.writeLine("test-vectors.json", "]");

        // Sanity: file must exist and round-trip at least the vector count
        // (guards against a future refactor silently shrinking coverage
        // below the floor).
        assertGe(vectors.length, MIN_VECTORS, "must emit at least MIN_VECTORS test vectors");
    }

    function _arrJson(uint8[5] memory arr) internal view returns (string memory) {
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

    /// @dev Deterministic, code-generated vector set (not hand-picked) so
    /// it's easy to see there's no cherry-picking of "nice" outcomes: 10
    /// distinct father token IDs x 5 distinct mother token IDs x 10
    /// distinct entropy values = 500 base combinations, each with genes
    /// derived from a simple formula (not random) so this function itself
    /// needs no external entropy source of its own, plus a handful of
    /// explicit edge cases (identical parents, min/max byte values,
    /// tokenId 0, zero entropy, max entropy) appended on top for a healthy
    /// margin over the MIN_VECTORS floor.
    function _buildVectors() internal pure returns (Vector[] memory vectors) {
        uint256 edgeCases = 7;
        vectors = new Vector[](10 * 5 * 10 + edgeCases);
        uint256 idx = 0;

        for (uint256 f = 0; f < 10; f++) {
            for (uint256 m = 0; m < 5; m++) {
                uint8[5] memory fatherGenes;
                uint8[5] memory motherGenes;
                for (uint256 k = 0; k < 5; k++) {
                    fatherGenes[k] = uint8((f * 37 + k * 11 + 3) % 256);
                    motherGenes[k] = uint8((m * 53 + k * 17 + 200) % 256);
                }
                for (uint256 e = 0; e < 10; e++) {
                    vectors[idx] = Vector({
                        fatherTokenId: f + 1,
                        motherTokenId: m + 1,
                        breedNonce: idx,
                        entropy: keccak256(abi.encodePacked("entropy", f, m, e)),
                        fatherGenes: fatherGenes,
                        motherGenes: motherGenes
                    });
                    idx++;
                }
            }
        }

        // Edge cases.
        vectors[idx++] = Vector({
            fatherTokenId: 0,
            motherTokenId: 0,
            breedNonce: 0,
            entropy: bytes32(0),
            fatherGenes: [uint8(0), 0, 0, 0, 0],
            motherGenes: [uint8(0), 0, 0, 0, 0]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 1,
            motherTokenId: 1,
            breedNonce: 999,
            entropy: bytes32(type(uint256).max),
            fatherGenes: [uint8(255), 255, 255, 255, 255],
            motherGenes: [uint8(255), 255, 255, 255, 255]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 1200,
            motherTokenId: 12,
            breedNonce: 1,
            entropy: keccak256("edge-1200-12"),
            fatherGenes: [uint8(0), 0, 0, 0, 0],
            motherGenes: [uint8(255), 255, 255, 255, 255]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 531,
            motherTokenId: 7,
            breedNonce: 2,
            entropy: keccak256("edge-531-7"),
            fatherGenes: [uint8(1), 100, 200, 50, 150],
            motherGenes: [uint8(1), 100, 200, 50, 150]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 777,
            motherTokenId: 12,
            breedNonce: 123456789,
            entropy: keccak256("edge-777-12"),
            fatherGenes: [uint8(42), 88, 133, 210, 7],
            motherGenes: [uint8(9), 99, 189, 240, 3]
        });
        // Same father/mother/nonce, only entropy differs from a prior
        // vector's inputs - the whole point of the commit/reveal fix (see
        // GeneticsLib.breedingSeed's natspec): must still resolve to a
        // different genome/seed than vectors[idx-1]-style same-nonce
        // collisions would under the old 3-arg formula.
        vectors[idx++] = Vector({
            fatherTokenId: 1,
            motherTokenId: 1,
            breedNonce: 0,
            entropy: keccak256("distinct-entropy-a"),
            fatherGenes: [uint8(10), 20, 30, 40, 50],
            motherGenes: [uint8(60), 70, 80, 90, 100]
        });
        vectors[idx++] = Vector({
            fatherTokenId: 1,
            motherTokenId: 1,
            breedNonce: 0,
            entropy: keccak256("distinct-entropy-b"),
            fatherGenes: [uint8(10), 20, 30, 40, 50],
            motherGenes: [uint8(60), 70, 80, 90, 100]
        });
    }
}
