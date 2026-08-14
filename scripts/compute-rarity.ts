// One-time/occasional background job: fetches all 1200 HOODCHAN tokens'
// metadata, tallies trait-value frequency per category, scores each token by
// an inverse-frequency-weighted sum across its own trait values (lower
// frequency = rarer), and writes the result into the store as one JSON blob
// under the "rarity-index" key (see lib/store.ts's writeRarityIndex).
//
// No explicit rarity/tier trait_type exists on ordinary tokens - confirmed
// by sampling tokens 1, 50, 300, 700, 1100 live before writing this script:
// every one only has Backgrounds/Bodies/Faces/Hats, no "Rarity"/"Tier"
// field. A full run did turn up one exception - token #114 carries an
// explicit `Rarity: LEGENDARY` / `Legendary 1/1: BREAD MAKER` pair, a true
// 1-of-1 - but the other ~1199 tokens don't have anything like it. Computing
// rarity ourselves from trait-value frequency is therefore still the only
// way to rank the collection as a whole; as a sanity check, the
// inverse-frequency scoring below independently ranked #114 the single
// rarest token in the collection with no knowledge of its explicit Rarity
// field, purely because its trait values are shared by no one else.
//
// Run with: npx tsx scripts/compute-rarity.ts
//
// Chunked concurrency (not 1200 requests at once) - same
// OWNERSHIP_CHECK_CONCURRENCY pattern lib/chain.ts already uses for
// wallet-token ownership scans, to avoid hammering the IPFS gateways this
// collection's metadata lives behind. Even so, the gateways serving this
// collection's CIDs are observably rate-limited (429s show up well before
// 1200 requests) - retries use exponential backoff, not immediate retries,
// since firing right back at a 429 just draws another 429.

import { fetchTokenMetadata, type TokenMetadata } from "../lib/chain";
import { writeRarityIndex, type RarityIndex } from "../lib/store";

const TOTAL_SUPPLY = 1200;
const FETCH_CONCURRENCY = 8;
const MAX_ATTEMPTS = 4; // per-token retry - IPFS gateways are observably flaky/rate-limited
const BACKOFF_BASE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(tokenId: number): Promise<TokenMetadata | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchTokenMetadata(tokenId);
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn(
          `Token ${tokenId}: failed after ${MAX_ATTEMPTS} attempts (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        return null;
      }
      // Exponential backoff with jitter - gives a rate-limited gateway room
      // to recover before the next attempt instead of hammering it again
      // immediately.
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
    if (i + FETCH_CONCURRENCY < ids.length) await sleep(400); // brief pause between chunks
    process.stdout.write(
      `\rFetched ${done}/${TOTAL_SUPPLY} tokens (${results.size} succeeded)`,
    );
  }
  process.stdout.write("\n");
  return results;
}

// key = "trait_type::value" (case-sensitive, matches raw metadata values)
function buildFrequencyTable(
  metadataById: Map<number, TokenMetadata>,
): Map<string, number> {
  const freq = new Map<string, number>();
  for (const meta of metadataById.values()) {
    for (const attr of meta.attributes) {
      if (!attr.trait_type || attr.value === undefined) continue;
      const key = `${attr.trait_type}::${attr.value}`;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  return freq;
}

// Standard inverse-frequency rarity score: sum of (totalTokens / count) for
// each of the token's own trait values - a trait value only 3 tokens share
// contributes far more than one 400 tokens share. Higher score = rarer.
function scoreToken(
  meta: TokenMetadata,
  freq: Map<string, number>,
  totalTokens: number,
): number {
  let score = 0;
  for (const attr of meta.attributes) {
    if (!attr.trait_type || attr.value === undefined) continue;
    const key = `${attr.trait_type}::${attr.value}`;
    const count = freq.get(key) ?? totalTokens;
    score += totalTokens / count;
  }
  return score;
}

async function main() {
  console.log(`Fetching metadata for ${TOTAL_SUPPLY} HOODCHAN tokens...`);
  const metadataById = await fetchAllMetadata();
  const succeeded = metadataById.size;
  const failed = TOTAL_SUPPLY - succeeded;
  console.log(
    `Done fetching: ${succeeded} succeeded, ${failed} failed/skipped.`,
  );

  if (succeeded === 0) {
    console.error(
      "No metadata fetched at all - aborting, not writing an empty index.",
    );
    process.exit(1);
  }

  const freq = buildFrequencyTable(metadataById);
  console.log(
    `Frequency table built across ${freq.size} distinct trait values.`,
  );

  const scored = [...metadataById.entries()].map(([tokenId, meta]) => ({
    tokenId,
    score: scoreToken(meta, freq, succeeded),
    meta,
  }));
  scored.sort((a, b) => b.score - a.score); // highest score = rarest = rank 1

  const entries: RarityIndex["entries"] = {};
  scored.forEach((entry, i) => {
    entries[String(entry.tokenId)] = { score: entry.score, rank: i + 1 };
  });

  const index: RarityIndex = {
    computedAt: new Date().toISOString(),
    totalSupply: succeeded,
    entries,
  };

  await writeRarityIndex(index);

  const rareThreshold = Math.max(1, Math.round(succeeded * 0.05));
  console.log(`\nWrote rarity-index: ${succeeded} tokens scored.`);
  console.log(
    `Top 5% rarity threshold: rank <= ${rareThreshold} (${rareThreshold} tokens flagged rare).`,
  );
  console.log(`\nTop 10 rarest tokens:`);
  for (const entry of scored.slice(0, 10)) {
    const traits = entry.meta.attributes
      .map((a) => `${a.trait_type}=${a.value}`)
      .join(", ");
    console.log(
      `  #${entry.tokenId} (rank ${entries[String(entry.tokenId)].rank}, score ${entry.score.toFixed(2)}): ${traits}`,
    );
  }
}

main().catch((err) => {
  console.error("compute-rarity failed:", err);
  process.exit(1);
});
