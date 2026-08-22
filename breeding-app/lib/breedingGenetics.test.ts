import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBreedingSeed, resolveGenome } from "./breedingGenetics";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Vector {
  fatherTokenId: number;
  motherTokenId: number;
  breedNonce: number;
  entropy: string;
  fatherGenes: number[];
  motherGenes: number[];
  expectedSeed: string;
  expectedGenome: number[];
}

// contracts/test-vectors.json is generated directly by Solidity itself
// (contracts/test/GenerateTestVectors.t.sol, run via `forge test`) - a
// passing run of this file is a real bit-for-bit parity proof against the
// deployed contract's own GeneticsLib arithmetic, not a hand-written
// expectation that could drift from it.
const vectors: Vector[] = JSON.parse(
  readFileSync(join(__dirname, "../contracts/test-vectors.json"), "utf-8"),
);

describe("breedingGenetics parity vs Solidity GeneticsLib", () => {
  it("loaded a real, healthy vector set (>= 500 per the fixture's own floor)", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(500);
  });

  it("matches every vector's expectedSeed and expectedGenome exactly", () => {
    for (const v of vectors) {
      const seed = computeBreedingSeed(
        v.fatherTokenId,
        v.motherTokenId,
        v.breedNonce,
        v.entropy,
      );
      expect(seed.toString()).toBe(v.expectedSeed);

      const genome = resolveGenome(v.fatherGenes, v.motherGenes, seed);
      expect(genome).toEqual(v.expectedGenome);
    }
  });
});
