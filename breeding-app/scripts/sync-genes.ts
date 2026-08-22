#!/usr/bin/env -S npx tsx
// The off-chain HOODCHAN metadata-sync script. contracts/script/Deploy.s.sol
// itself says (see its "After deploy" prerequisite #5): "run the off-chain
// HOODCHAN gene-sync script ... before any breed() call". This is that
// script. Without it, BreedingController.breed() reverts GenesNotSet() for
// every real HOODCHAN parent, forever - hoodchanGenesSet[tokenId] only ever
// becomes true via setHoodchanGenes(Batch), and nothing else in this repo
// calls that function.
//
// What it does, per HOODCHAN token:
//   1. Reads tokenURI live (lib/chain.ts, raw fetch, no SDK) and parses its
//      attributes.
//   2. Maps Hats/Faces/Bodies/Backgrounds/Extra through
//      lib/traitRegistry.ts's COMBINED_VALUE_INDEX into a uint8[5] genome -
//      see that file's header for why the NUMBERING is genetics-load-bearing
//      (the reserved 248..255 band, not the ascending-rarity ORDERING,
//      which the v2 design's coin-flip genetics made non-load-bearing - see
//      the design spec's "Trait registry" section), not just a lookup
//      convenience.
//   3. Batches results into setHoodchanGenesBatch calldata
//      (lib/breedingController.ts's builder - the real ABI, not a
//      hand-guessed function name).
//
// STATUS:"Upgraded" / --check-opensea / lib/openseaToken.ts are REMOVED
// (not just unused) as of the v2 design spec: that machinery existed only
// to gate ETH as a second siring-fee currency, and the v1 dual-currency
// ETH path is cut from scope entirely - CHAN is the ONLY fee currency now
// (see BreedingController's `chanToken` immutable and lib/config.ts's
// CHAN_TOKEN_ADDRESS comment). Trait ORDERING (ascending-rarity) is
// display-only in v2; only the reserved 248..255 mutation/legendary band
// stays load-bearing (see traitRegistry.ts's LEGENDARY_RESERVED_START).
//
// ============================================================================
// SAFETY - READ BEFORE ADDING --broadcast TO ANY COMMAND LINE
// ============================================================================
// This script DEFAULTS TO DRY RUN. No network WRITE and no signer are ever
// constructed unless BOTH of the following are true at once:
//   1. --broadcast is passed on the command line, AND
//   2. process.env.SEND_REAL_TX === "I_UNDERSTAND_THIS_SENDS_REAL_TRANSACTIONS"
// Missing either one keeps the script in dry-run mode, full stop - see
// requireBroadcastConsent() below, which is the ONLY place either condition
// is checked, and buildSigner(), which is the ONLY place a private key is
// ever read from the environment. A real send additionally requires
// PRIVATE_KEY (an operator hot key registered via
// BreedingController.setOperator - NEVER the deployer/owner key; see
// contracts/README.md and .claude/rules/credentials.md's "never store
// secrets in plaintext files" rule - this reads an env var by design ONLY
// for this narrow operator-bot use case, same convention
// script/Deploy.s.sol documents for why ITS deployer key is Foundry
// keystore-only, not env - the two key roles are deliberately different:
// operator is a low-privilege, rotatable hot key; deployer/owner is not).
//
// Usage:
//   npx tsx scripts/sync-genes.ts                        # dry run, tokens 1..1200
//   npx tsx scripts/sync-genes.ts --start 1 --end 50      # dry run, subset
//   npx tsx scripts/sync-genes.ts --tokens 1,531,777,1067,700  # dry run, explicit list (sample anchors)
//   npx tsx scripts/sync-genes.ts --out data/sync-report.json
//   SEND_REAL_TX=I_UNDERSTAND_THIS_SENDS_REAL_TRANSACTIONS PRIVATE_KEY=0x... \
//     npx tsx scripts/sync-genes.ts --broadcast --start 1 --end 50
import { fetchTokenMetadata, type TokenMetadata } from "../lib/chain";
import { HOODCHAN_CONTRACT, DEFAULT_RPC_URL } from "../lib/config";
import {
  GENE_SLOTS,
  HOODCHAN_TRAIT_KEY,
  HOODCHAN_COSMETIC_TRAIT_KEY,
  LEGENDARY_SENTINEL_GENES,
  valueToIndex,
  type GeneSlot,
} from "../lib/traitRegistry";
import { buildSetHoodchanGenesBatchTx } from "../lib/breedingController";
import { writeFileSync } from "node:fs";

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
interface Args {
  start: number;
  end: number;
  tokens: number[] | null;
  limit: number | null;
  concurrency: number;
  batchSize: number;
  broadcast: boolean;
  outPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    start: 1,
    end: 1200,
    tokens: null,
    limit: null,
    concurrency: 8,
    batchSize: 200,
    broadcast: false,
    outPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start") args.start = Number(argv[++i]);
    else if (a === "--end") args.end = Number(argv[++i]);
    else if (a === "--tokens") {
      args.tokens = argv[++i]
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    } else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (a === "--broadcast") args.broadcast = true;
    else if (a === "--dry-run")
      args.broadcast = false; // explicit no-op, dry-run is already default
    else if (a === "--out") args.outPath = argv[++i];
  }
  return args;
}

// ----------------------------------------------------------------------------
// Fetch with retry/backoff - same shape as scripts/build-trait-registry.ts
// and the parent h00dchan app's scripts/compute-rarity.ts (IPFS/metadata
// gateways for this collection are observably flaky under burst load; retry
// with backoff, not immediate retry).
// ----------------------------------------------------------------------------
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
          `Token ${tokenId}: metadata fetch failed after ${MAX_ATTEMPTS} attempts (${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      }
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.random() * 500);
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Per-token gene resolution
// ----------------------------------------------------------------------------
export interface SyncedToken {
  tokenId: number;
  genes: [number, number, number, number, number];
  cosmeticGrillz: string | null;
  legendary: boolean;
  missingSlots: GeneSlot[]; // slots that fell back to NONE_INDEX because the attribute was absent
  raw: TokenMetadata;
}

function findAttr(meta: TokenMetadata, traitType: string): string | undefined {
  const attr = meta.attributes.find(
    (a) => a.trait_type?.toLowerCase() === traitType.toLowerCase(),
  );
  return attr?.value !== undefined ? String(attr.value) : undefined;
}

function isLegendaryOneOfOne(meta: TokenMetadata): boolean {
  return meta.attributes.some(
    (a) =>
      a.trait_type === "Rarity" &&
      String(a.value).toUpperCase() === "LEGENDARY",
  );
}

function resolveToken(meta: TokenMetadata): SyncedToken {
  const tokenId = Number(meta.tokenId);

  if (isLegendaryOneOfOne(meta)) {
    return {
      tokenId,
      genes: LEGENDARY_SENTINEL_GENES,
      cosmeticGrillz: null,
      legendary: true,
      missingSlots: [],
      raw: meta,
    };
  }

  const missingSlots: GeneSlot[] = [];
  const genes = GENE_SLOTS.map((slot) => {
    const traitType = HOODCHAN_TRAIT_KEY[slot];
    const value = findAttr(meta, traitType);
    if (value === undefined) missingSlots.push(slot);
    return valueToIndex(slot, value);
  }) as [number, number, number, number, number];

  const cosmeticGrillz = findAttr(meta, HOODCHAN_COSMETIC_TRAIT_KEY) ?? null;

  return {
    tokenId,
    genes,
    cosmeticGrillz,
    legendary: false,
    missingSlots,
    raw: meta,
  };
}

// ----------------------------------------------------------------------------
// Broadcast consent gate - see this file's SAFETY header. This is the ONLY
// function that may return `true`.
// ----------------------------------------------------------------------------
const REQUIRED_CONSENT_VALUE = "I_UNDERSTAND_THIS_SENDS_REAL_TRANSACTIONS";

function requireBroadcastConsent(args: Args): boolean {
  if (!args.broadcast) return false;
  if (process.env.SEND_REAL_TX !== REQUIRED_CONSENT_VALUE) {
    console.error(
      `\n--broadcast was passed but SEND_REAL_TX is not set to the exact required value.\n` +
        `Refusing to send anything. To actually broadcast, set:\n` +
        `  SEND_REAL_TX=${REQUIRED_CONSENT_VALUE}\n` +
        `in the environment, in addition to --broadcast. This script never sends\n` +
        `a transaction with only one of those two conditions met.\n`,
    );
    return false;
  }
  return true;
}

async function buildSigner() {
  // Only ever called after requireBroadcastConsent() has already returned
  // true - see main(). ethers is a declared dependency already (package.json)
  // used elsewhere in this app for calldata encoding; this is the one place
  // it's used to actually sign/send, and only in the --broadcast path.
  const { Wallet, JsonRpcProvider } = await import("ethers");
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "PRIVATE_KEY is not set. --broadcast requires an operator hot key (registered via " +
        "BreedingController.setOperator) - never the deployer/owner key. See this file's SAFETY header.",
    );
  }
  const provider = new JsonRpcProvider(DEFAULT_RPC_URL);
  return new Wallet(privateKey, provider);
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const willBroadcast = requireBroadcastConsent(args);

  const ids =
    args.tokens ??
    Array.from({ length: args.end - args.start + 1 }, (_, i) => args.start + i);
  const targetIds = args.limit ? ids.slice(0, args.limit) : ids;

  console.log(
    `${willBroadcast ? "BROADCAST" : "DRY RUN"} - syncing ${targetIds.length} HOODCHAN token(s) ` +
      `(${targetIds[0]}..${targetIds[targetIds.length - 1]}) against ${HOODCHAN_CONTRACT}`,
  );

  const results: SyncedToken[] = [];
  let done = 0;
  for (const batch of chunk(targetIds, args.concurrency)) {
    const metas = await Promise.all(batch.map((id) => fetchWithRetry(id)));
    for (let i = 0; i < batch.length; i++) {
      const meta = metas[i];
      if (!meta) continue;
      results.push(resolveToken(meta));
    }
    done += batch.length;
    process.stdout.write(
      `\rFetched+mapped ${done}/${targetIds.length} (${results.length} resolved)`,
    );
  }
  process.stdout.write("\n");

  const legendaries = results.filter((r) => r.legendary);
  const withMissingSlots = results.filter((r) => r.missingSlots.length > 0);

  console.log(`\nResolved ${results.length}/${targetIds.length} tokens.`);
  console.log(
    `  Legendary 1/1 (sentinel genes, needs manual review): ${legendaries.length}`,
  );
  console.log(
    `  Tokens with >=1 missing slot (fell back to NONE_INDEX=0): ${withMissingSlots.length}`,
  );

  console.log(`\nSample rows:`);
  const anchors = [531, 777, 1067];
  const sampleIds = new Set([
    ...results.slice(0, 5).map((r) => r.tokenId),
    ...anchors.filter((a) => results.some((r) => r.tokenId === a)),
  ]);
  for (const r of results.filter((row) => sampleIds.has(row.tokenId))) {
    const names = r.raw.attributes
      .map((a) => `${a.trait_type}=${a.value}`)
      .join(", ");
    console.log(
      `  #${r.tokenId}: genes=[${r.genes.join(",")}] legendary=${r.legendary} ` +
        `grillz=${r.cosmeticGrillz ?? "-"} | ${names}`,
    );
  }

  if (legendaries.length > 0) {
    console.log(
      `\nLegendary tokens flagged for manual review (sentinel genes assigned):`,
    );
    for (const l of legendaries) {
      console.log(`  #${l.tokenId}: ${JSON.stringify(l.raw.attributes)}`);
    }
  }

  // ---- Build batch calldata (built either way - dry run prints it, doesn't send it) ----
  const geneBatches = chunk(
    results.map((r) => ({ tokenId: r.tokenId, genes: r.genes })),
    args.batchSize,
  );

  console.log(
    `\nWould send ${geneBatches.length} setHoodchanGenesBatch call(s) (batch size <= ${args.batchSize}).`,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    mode: willBroadcast ? "broadcast" : "dry-run",
    contract: HOODCHAN_CONTRACT,
    tokenCount: results.length,
    legendaryCount: legendaries.length,
    missingSlotCount: withMissingSlots.length,
    tokens: results.map((r) => ({
      tokenId: r.tokenId,
      genes: r.genes,
      legendary: r.legendary,
      cosmeticGrillz: r.cosmeticGrillz,
      missingSlots: r.missingSlots,
    })),
  };
  if (args.outPath) {
    writeFileSync(args.outPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`\nWrote report to ${args.outPath}`);
  }

  if (!willBroadcast) {
    console.log(
      `\nDry run complete - nothing was sent. Re-run with --broadcast and\n` +
        `SEND_REAL_TX=${REQUIRED_CONSENT_VALUE} PRIVATE_KEY=<operator key> to actually send.`,
    );
    return;
  }

  // ---- Real send path - never reached unless requireBroadcastConsent() passed ----
  const signer = await buildSigner();
  console.log(
    `\nBroadcasting from operator address ${await signer.getAddress()}...`,
  );
  for (const [i, batch] of geneBatches.entries()) {
    const tx = buildSetHoodchanGenesBatchTx(
      batch.map((b) => b.tokenId),
      batch.map((b) => b.genes),
    );
    const response = await signer.sendTransaction(tx);
    console.log(
      `setHoodchanGenesBatch [${i + 1}/${geneBatches.length}] -> ${response.hash}`,
    );
    await response.wait();
  }
  console.log(`\nBroadcast complete.`);
}

main().catch((err) => {
  console.error("sync-genes failed:", err);
  process.exit(1);
});
