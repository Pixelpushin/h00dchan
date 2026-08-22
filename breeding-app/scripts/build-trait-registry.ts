// One-time/occasional generator for lib/traitRegistry.ts's numeric HOODCHAN
// tables (HOODCHAN_VALUE_INDEX / HOODCHAN_INDEX_VALUE). Mirrors the parent
// h00dchan app's scripts/compute-rarity.ts almost exactly (same
// fetch-all-1200 + chunked-concurrency + exponential-backoff approach,
// verified live to still be the right shape for this metadata service - see
// that file's own header comment for the gateway/rate-limit history), but
// instead of an inverse-frequency *score*, this produces a plain ascending
// frequency ORDER per gene slot and writes it out as TypeScript source, not
// a runtime JSON blob.
//
// WHY THIS MATTERS (see lib/traitRegistry.ts's own header for the full
// story): GeneticsLib.sol's dominant/recessive draw is `p1 > p2 ? p1 : p2`
// wins 60% of the time (GeneticsLib.sol:106-108) - the raw numeric index
// assigned to a trait value literally controls whether it's genetically
// dominant. This script's ordering rule is: common trait value -> low
// index, rare trait value -> high index, so rarity and genetic dominance
// point the same direction (a trait only 3 fathers in 1200 have SHOULD
// dominate a trait 400 fathers share, not the other way around).
//
// Run with: npx tsx scripts/build-trait-registry.ts
//
// Output is REVIEWED AND HAND-COMMITTED, not regenerated on every build -
// see lib/traitRegistry.ts's header for why re-running this after deploy is
// dangerous (reordering corrupts on-chain gene semantics for every already-
// synced father).
import { fetchTokenMetadata, type TokenMetadata } from "../lib/chain";
import { HOODCHAN_CONTRACT } from "../lib/config";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOTAL_SUPPLY = 1200;
const FETCH_CONCURRENCY = 8;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(tokenId: number): Promise<TokenMetadata | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchTokenMetadata(HOODCHAN_CONTRACT, tokenId, "HOODCHAN");
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn(
          `Token ${tokenId}: failed after ${MAX_ATTEMPTS} attempts (${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      }
      const delay = BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.random() * 500;
      await sleep(delay);
    }
  }
  return null;
}

async function fetchAllMetadata(): Promise<Map<number, TokenMetadata>> {
  const results = new Map<number, TokenMetadata>();
  const ids = Array.from({ length: TOTAL_SUPPLY }, (_, i) => i + 1);
  let done = 0;
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const batch = ids.slice(i, i + FETCH_CONCURRENCY);
    const metas = await Promise.all(batch.map((id) => fetchWithRetry(id)));
    batch.forEach((id, j) => {
      const meta = metas[j];
      if (meta) results.set(id, meta);
    });
    done += batch.length;
    if (i + FETCH_CONCURRENCY < ids.length) await sleep(400);
    process.stdout.write(
      `\rFetched ${done}/${TOTAL_SUPPLY} tokens (${results.size} succeeded)`,
    );
  }
  process.stdout.write("\n");
  return results;
}

// Gene-slot -> the HOODCHAN metadata trait_type that feeds it. "Extra" for
// accessory confirmed live (2026-08-22 verification, not spec-asserted):
// tokens #1/#50/#300 etc lack it, but #700 and #1100 (ordinary, non-
// Upgraded tokens) both DO carry an "Extra" attribute
// (CHILLING / SUPER NINJA TURTLE) - so it's a real, if inconsistently
// populated, ordinary trait category, not an Upgraded-only field. "Grillz"
// is deliberately NOT mapped to any slot - see lib/traitRegistry.ts's
// collapse-rule note for why it's treated as cosmetic/non-genetic.
const HOODCHAN_SLOT_KEYS: Record<string, string> = {
  hat: "Hats",
  face: "Faces",
  body: "Bodies",
  background: "Backgrounds",
  accessory: "Extra",
};

function buildFrequency(
  metadataById: Map<number, TokenMetadata>,
  traitType: string,
): Map<string, number> {
  const freq = new Map<string, number>();
  for (const meta of metadataById.values()) {
    const attr = meta.attributes.find(
      (a) => a.trait_type?.toLowerCase() === traitType.toLowerCase(),
    );
    if (!attr || attr.value === undefined) continue;
    const value = String(attr.value);
    freq.set(value, (freq.get(value) ?? 0) + 1);
  }
  return freq;
}

async function main() {
  console.log(
    `Fetching metadata for ${TOTAL_SUPPLY} HOODCHAN tokens from ${HOODCHAN_CONTRACT}...`,
  );
  const metadataById = await fetchAllMetadata();
  console.log(`Done: ${metadataById.size}/${TOTAL_SUPPLY} succeeded.`);
  if (metadataById.size === 0) {
    console.error("No metadata fetched - aborting.");
    process.exit(1);
  }

  const perSlot: Record<string, Array<{ value: string; count: number }>> = {};
  for (const [slot, traitType] of Object.entries(HOODCHAN_SLOT_KEYS)) {
    const freq = buildFrequency(metadataById, traitType);
    const entries = [...freq.entries()]
      .map(([value, count]) => ({ value, count }))
      // Ascending by count (rarest last is wrong for OUR purpose - we want
      // MOST COMMON first / index 0, so ascending count order IS the index
      // order directly: index 0 = lowest count seen first... no: we want
      // common=low index, so sort ASCENDING by count would put the rarest
      // (lowest count) at index 0, which is backwards. Sort DESCENDING by
      // count so the most common value gets the lowest index.
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    perSlot[slot] = entries;
    console.log(`\n${slot} (${traitType}): ${entries.length} distinct values`);
    for (const e of entries) console.log(`  ${e.value}: ${e.count}`);
  }

  // Also surface any explicit 1-of-1 "Legendary" tokens (e.g. #114's
  // `Legendary 1/1` field) for manual review - these tokens have NO normal
  // slot attributes at all, so they can't be folded into the frequency
  // tables above; sync-genes.ts handles them as a special case at sync
  // time (reserved top-of-range index per slot), not by adding a fake
  // frequency-1 entry here.
  const legendaries = [...metadataById.values()].filter((m) =>
    m.attributes.some(
      (a) => a.trait_type === "Rarity" && a.value === "LEGENDARY",
    ),
  );
  console.log(
    `\nLegendary 1/1 tokens found (no normal slot attributes): ${legendaries.length}`,
  );
  for (const l of legendaries) {
    console.log(`  #${l.tokenId}: ${JSON.stringify(l.attributes)}`);
  }

  const outPath = join(__dirname, "../data/hoodchan-trait-frequency.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalTokensFetched: metadataById.size,
        totalSupply: TOTAL_SUPPLY,
        perSlot,
        legendaryOneOfOnes: legendaries.map((l) => ({
          tokenId: l.tokenId,
          attributes: l.attributes,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nWrote raw frequency data to ${outPath}`);
  console.log(
    `Next: hand-transcribe this into lib/traitRegistry.ts's HOODCHAN_VALUE_INDEX tables (see that file's header for why this is a manual, reviewed step, not auto-applied).`,
  );
}

main().catch((err) => {
  console.error("build-trait-registry failed:", err);
  process.exit(1);
});
