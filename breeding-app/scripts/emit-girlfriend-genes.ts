// Emits data/girlfriend-genes.json: for each of the 12 dummy
// HOODCHAN_GIRLFRIENDS tokens (lib/girlfriendsData.ts / data/girlfriends/
// *.json - both, cross-checked below), maps its real minted attributes
// through lib/traitRegistry.ts's COMBINED_VALUE_INDEX into a uint8[5]
// genome, ready to hand to HoodchanGirlfriends.mint(to, genes) at deploy
// time (see contracts/src/HoodchanGirlfriends.sol - owner-only mint that
// takes the genome directly, no on-chain trait strings, same reasoning as
// HoodchanBabies' packed storage: the string<->byte mapping is this
// off-chain registry's job, not the contract's).
//
// Run with: npx tsx scripts/emit-girlfriend-genes.ts
//
// Deterministic and idempotent - re-running produces byte-identical output
// as long as lib/traitRegistry.ts and data/girlfriends/*.json haven't
// changed, so this is safe to re-run after any registry update (unlike
// scripts/sync-genes.ts against ALREADY-SYNCED real HOODCHAN fathers -
// these 12 tokens haven't been minted anywhere yet, so there's no
// desync-existing-on-chain-state risk here the way there is for HOODCHAN).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENE_SLOTS,
  GIRLFRIEND_TRAIT_KEY,
  GIRLFRIEND_COSMETIC_TRAIT_KEY,
  valueToIndex,
  type GeneSlot,
} from "../lib/traitRegistry";
import { GIRLFRIEND_DEFINITIONS } from "../lib/girlfriendsData";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GIRLFRIENDS_DATA_DIR = join(__dirname, "../data/girlfriends");
const OUT_PATH = join(__dirname, "../data/girlfriend-genes.json");

interface GirlfriendMetadataJson {
  name: string;
  description: string;
  image: string;
  attributes: Array<{ trait_type: string; value: string }>;
}

interface GirlfriendGeneEntry {
  tokenId: number;
  name: string;
  genes: [number, number, number, number, number];
  slotValues: Record<GeneSlot, string>;
  cosmeticGrills: string | null;
}

function findAttr(
  attrs: Array<{ trait_type: string; value: string }>,
  traitType: string,
): string | undefined {
  return attrs.find(
    (a) => a.trait_type.toLowerCase() === traitType.toLowerCase(),
  )?.value;
}

function main() {
  const files = readdirSync(GIRLFRIENDS_DATA_DIR).filter((f) =>
    f.endsWith(".json"),
  );
  if (files.length === 0) {
    console.error(
      `No girlfriend metadata JSON files found in ${GIRLFRIENDS_DATA_DIR}`,
    );
    process.exit(1);
  }

  const entries: GirlfriendGeneEntry[] = [];
  const warnings: string[] = [];

  for (const file of files.sort((a, b) => parseInt(a) - parseInt(b))) {
    const tokenId = parseInt(file, 10);
    if (!Number.isFinite(tokenId)) continue;

    const metaPath = join(GIRLFRIENDS_DATA_DIR, file);
    const meta: GirlfriendMetadataJson = JSON.parse(
      readFileSync(metaPath, "utf-8"),
    );

    // Cross-check against lib/girlfriendsData.ts's own hand-authored
    // definitions (the single source of truth per that file's header) -
    // any mismatch means the two have drifted and needs investigation
    // before trusting either for a real mint.
    const definition = GIRLFRIEND_DEFINITIONS.find(
      (d) => d.tokenId === tokenId,
    );
    if (!definition) {
      warnings.push(
        `Token ${tokenId}: present in data/girlfriends/${file} but missing from lib/girlfriendsData.ts's GIRLFRIEND_DEFINITIONS.`,
      );
    }

    const slotValues: Record<GeneSlot, string> = {} as Record<GeneSlot, string>;
    const genes = GENE_SLOTS.map((slot) => {
      const traitType = GIRLFRIEND_TRAIT_KEY[slot];
      const value = findAttr(meta.attributes, traitType);
      if (value === undefined) {
        warnings.push(
          `Token ${tokenId}: missing "${traitType}" attribute for slot "${slot}".`,
        );
      } else {
        slotValues[slot] = value;
      }
      const index = valueToIndex(slot, value);
      if (value !== undefined && index === 0) {
        warnings.push(
          `Token ${tokenId}: slot "${slot}" value "${value}" did not resolve to a registered index (fell back to NONE_INDEX=0) - lib/traitRegistry.ts's girlfriend-only tables may be out of date.`,
        );
      }
      return index;
    }) as [number, number, number, number, number];

    const cosmeticGrills =
      findAttr(meta.attributes, GIRLFRIEND_COSMETIC_TRAIT_KEY) ?? null;

    entries.push({
      tokenId,
      name: meta.name,
      genes,
      slotValues,
      cosmeticGrills,
    });
  }

  if (entries.length !== 12) {
    warnings.push(
      `Expected exactly 12 dummy Girlfriend tokens, found ${entries.length}.`,
    );
  }

  const output = {
    generatedAt: new Date().toISOString(),
    registryVersion: 1,
    count: entries.length,
    girlfriends: entries,
    warnings,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${entries.length} girlfriend gene entries to ${OUT_PATH}`);
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  for (const e of entries) {
    console.log(`  #${e.tokenId} ${e.name}: genes=[${e.genes.join(",")}]`);
  }
}

main();
