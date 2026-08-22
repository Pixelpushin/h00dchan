import { describe, expect, it } from "vitest";
import {
  GENE_SLOTS,
  COMBINED_VALUE_INDEX,
  NONE_INDEX,
  LEGENDARY_RESERVED_START,
  LEGENDARY_SENTINEL_GENES,
  valueToIndex,
  indexToValue,
  byteToTraitName,
  resolveGenomeNames,
} from "./traitRegistry";
import { GIRLFRIEND_DEFINITIONS } from "./girlfriendsData";

describe("traitRegistry", () => {
  it("gives every slot a NONE_INDEX=0 for a missing attribute", () => {
    for (const slot of GENE_SLOTS) {
      expect(valueToIndex(slot, undefined)).toBe(NONE_INDEX);
    }
  });

  it("round-trips every combined-index value through valueToIndex/indexToValue", () => {
    for (const slot of GENE_SLOTS) {
      for (const [value, index] of Object.entries(COMBINED_VALUE_INDEX[slot])) {
        expect(valueToIndex(slot, value)).toBe(index);
        expect(indexToValue(slot, index)).toBe(value);
      }
    }
  });

  it("is case-insensitive (HOODCHAN ALL-CAPS vs Girlfriend Title-Case conventions)", () => {
    // "Durag" is a real girlfriend hat value - confirm a differently-cased
    // lookup still resolves to the same index.
    const canonical = valueToIndex("hat", "Durag");
    expect(canonical).toBeGreaterThan(0);
    expect(valueToIndex("hat", "durag")).toBe(canonical);
    expect(valueToIndex("hat", "DURAG")).toBe(canonical);
  });

  it("stays below the reserved legendary band for every real registered value", () => {
    for (const slot of GENE_SLOTS) {
      for (const index of Object.values(COMBINED_VALUE_INDEX[slot])) {
        expect(index).toBeLessThan(LEGENDARY_RESERVED_START);
        expect(index).toBeGreaterThan(NONE_INDEX);
      }
    }
  });

  it("registers all 12 girlfriend definitions' trait values in every slot's index", () => {
    // Every dummy Girlfriend's own attribute values must resolve to a real,
    // non-zero index in the shared value space - this is the "comparable
    // values in the same numeric space per slot" requirement (task item 2).
    const bySlotKey: Record<
      string,
      keyof (typeof GIRLFRIEND_DEFINITIONS)[number]["attributes"]
    > = {
      hat: "hats",
      face: "faces",
      body: "bodies",
      background: "backgrounds",
      accessory: "girlStuff",
    };
    for (const def of GIRLFRIEND_DEFINITIONS) {
      for (const slot of GENE_SLOTS) {
        const key = bySlotKey[slot];
        const value = def.attributes[key];
        expect(valueToIndex(slot, value)).toBeGreaterThan(NONE_INDEX);
      }
    }
  });

  it("byteToTraitName resolves the legendary sentinel band with an honest fallback label", () => {
    for (const slot of GENE_SLOTS) {
      const name = byteToTraitName(slot, 255);
      expect(name).toMatch(/^Legendary /);
    }
  });

  it("resolveGenomeNames resolves LEGENDARY_SENTINEL_GENES to 5 legendary-labeled slots", () => {
    const resolved = resolveGenomeNames(LEGENDARY_SENTINEL_GENES);
    expect(resolved).toHaveLength(5);
    for (const r of resolved) {
      expect(r.name).toMatch(/^Legendary /);
    }
  });

  it("byteToTraitName never throws for any byte 0-255 in any slot", () => {
    for (const slot of GENE_SLOTS) {
      for (let b = 0; b <= 255; b++) {
        expect(() => byteToTraitName(slot, b)).not.toThrow();
      }
    }
  });
});
