// Regenerates the 12 dummy HOODCHAN_GIRLFRIENDS metadata JSON files
// committed under data/girlfriends/ - run with:
//   npx tsx scripts/generate-girlfriends.ts
// (from within breeding-app/). Metadata (trait_types, per-token attribute
// values) is defined FIRST and lives independently in lib/girlfriendsData.ts
// - this script's only job is: generate art for each definition, upload it
// to Blob, and write the final ERC-721 metadata JSON.
//
// IDEMPOTENCY GUARD (do not remove): all 12 tokens' art is already
// generated and paid for. Every OpenAI image call here costs real money,
// so this script must NEVER silently regenerate (and re-bill) a token that
// already has a live image. Before touching any token, it HEAD-checks the
// existing committed `image` URL; if that URL is already live (HTTP 200,
// image/* content-type), the token is skipped entirely - no OpenAI call,
// no Blob upload, no file write. In practice this means running this
// script with no flags is a safe no-op against the current 12 committed
// files. See README.md's "Regenerating Girlfriend art" section for when
// (rarely) you'd actually want to override this with --force/--only.
//
// Flags:
//   --only=<id>[,<id>...]  Restrict the run to specific token IDs (1-12).
//   --force                Regenerate targeted tokens even if their
//                          current image is confirmed live. Combine with
//                          --only to target a single dead/replaced blob
//                          instead of nuking all 12.
//   --dry-run              Print the skip/generate decision for every
//                          targeted token without calling OpenAI, calling
//                          Blob, or writing any file. Use this to verify
//                          the guard before trusting a real run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GIRLFRIEND_DEFINITIONS } from "@/lib/girlfriendsData";
import { generateGirlfriendImage } from "@/lib/girlfriendsImage";

// Tiny inline .env.local loader (no dotenv dependency, matching this repo's
// zero-extra-dependency convention elsewhere) - only fills in vars that
// aren't already set in the environment, same precedence dotenv itself
// uses. Node's own --env-file flag would do this too, but that requires
// the file to exist or the process errors outright; this degrades to "just
// use whatever's already in the environment" instead, which is what lets
// the "env genuinely absent" branch below run cleanly rather than crashing
// before main() even starts.
function loadDotEnvLocal(): void {
  const envPath = path.join(scriptDir(), "..", ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // `vercel env pull` wraps values in double quotes - strip a single
    // matching pair so callers get the raw secret, not `"sk-..."` literally
    // (which is what OpenAI's API rejected the first time this ran).
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // `vercel env pull` preserved this particular secret with a literal
    // trailing `\n` (backslash-n, two characters - not a real newline) baked
    // into the stored value itself, confirmed by inspecting the raw pulled
    // file - almost certainly from whoever originally pasted the key into
    // Vercel's dashboard with a trailing newline. Strip it (and any real
    // trailing whitespace) so the key used in the Authorization header
    // matches what OpenAI actually issued, not a mangled copy.
    value = value.replace(/\\n$/, "").trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function scriptDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

loadDotEnvLocal();

const OUTPUT_DIR = path.join(scriptDir(), "..", "data", "girlfriends");

// Clearly-marked placeholder used only when OPENAI_API_KEY/
// BLOB_READ_WRITE_TOKEN are genuinely absent - never a silently-faked real
// image URL. The metadata API route (app/api/girlfriends/[tokenId]/route.ts)
// still serves the rest of the metadata correctly in that case; only
// `image` is a stand-in.
const PENDING_IMAGE_PLACEHOLDER =
  "PENDING_GENERATION: run `npx tsx scripts/generate-girlfriends.ts` with OPENAI_API_KEY and BLOB_READ_WRITE_TOKEN set";

interface Erc721Metadata {
  name: string;
  description: string;
  image: string;
  attributes: Array<{ trait_type: string; value: string }>;
}

interface Cli {
  onlyIds: Set<number> | null;
  force: boolean;
  dryRun: boolean;
}

function parseCli(argv: string[]): Cli {
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const onlyIds = onlyArg
    ? new Set(
        onlyArg
          .slice("--only=".length)
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n)),
      )
    : null;
  return {
    onlyIds,
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
  };
}

function toAttributesArray(
  attrs: (typeof GIRLFRIEND_DEFINITIONS)[number]["attributes"],
): Erc721Metadata["attributes"] {
  return [
    { trait_type: "Backgrounds", value: attrs.backgrounds },
    { trait_type: "Bodies", value: attrs.bodies },
    { trait_type: "Faces", value: attrs.faces },
    { trait_type: "Grills", value: attrs.grills },
    { trait_type: "Hats", value: attrs.hats },
    { trait_type: "Girl Stuff", value: attrs.girlStuff },
  ];
}

// Returns the existing committed image URL for this token IF it's
// confirmed live (HTTP 200, image/* content-type) - null otherwise (file
// missing, unreadable, still the placeholder string, or the URL no longer
// resolves to an image). A null result is the only thing that permits
// (re)generation below.
async function liveImageOrNull(outPath: string): Promise<string | null> {
  if (!existsSync(outPath)) return null;

  let existing: Erc721Metadata;
  try {
    existing = JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    return null;
  }

  const image = existing.image;
  if (!image || image.startsWith("PENDING_GENERATION")) return null;

  try {
    const res = await fetch(image, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.startsWith("image/")) return image;
  } catch {
    // Network hiccup, not a confirmed-dead blob - fall through and treat
    // as not-live so a transient failure doesn't get treated as "safe to
    // skip" (it re-checks/regenerates instead, which is the safer default
    // for a real run; --dry-run never reaches this branch's consequences
    // anyway since it never writes).
  }
  return null;
}

async function main() {
  const { onlyIds, force, dryRun } = parseCli(process.argv.slice(2));

  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
  const hasBlobToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const canGenerate = hasOpenAiKey && hasBlobToken;

  if (!canGenerate && !dryRun) {
    console.warn(
      "OPENAI_API_KEY and/or BLOB_READ_WRITE_TOKEN missing - tokens that " +
        "need (re)generation will be left untouched rather than written " +
        "with a placeholder over a possibly-still-good file. Once both " +
        "are set, re-run:\n  npx tsx scripts/generate-girlfriends.ts",
    );
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  let skipped = 0;
  let generated = 0;
  let untouched = 0;

  for (const def of GIRLFRIEND_DEFINITIONS) {
    if (onlyIds && !onlyIds.has(def.tokenId)) continue;

    const outPath = path.join(OUTPUT_DIR, `${def.tokenId}.json`);
    const liveImage = await liveImageOrNull(outPath);

    if (liveImage && !force) {
      console.log(
        `SKIP  #${def.tokenId}: already live (${liveImage}) - pass --force to regenerate.`,
      );
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(
        `[dry-run] #${def.tokenId}: would ${liveImage ? "REGENERATE (--force)" : "GENERATE"} - no OpenAI/Blob call made.`,
      );
      continue;
    }

    let image = PENDING_IMAGE_PLACEHOLDER;
    if (canGenerate) {
      console.log(
        `${liveImage ? "REGENERATING" : "GENERATING"} image for token #${def.tokenId}...`,
      );
      const result = await generateGirlfriendImage(def.attributes);
      image = result.blobUrl;
      generated += 1;
    } else if (!existsSync(outPath)) {
      // Only ever write a placeholder for a token with no existing file -
      // never clobber a possibly-still-good committed file just because
      // keys are missing this run.
      console.log(
        `Writing placeholder metadata for token #${def.tokenId} (no API keys configured).`,
      );
    } else {
      console.warn(
        `SKIP  #${def.tokenId}: needs (re)generation but OPENAI_API_KEY/BLOB_READ_WRITE_TOKEN are missing - leaving existing file untouched.`,
      );
      untouched += 1;
      continue;
    }

    const metadata: Erc721Metadata = {
      name: def.name,
      description:
        "A HOODCHAN Girlfriend - dummy placeholder collection standing in " +
        "for the real Girlfriends contract until the official team ships " +
        "it (see docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md). " +
        "Mother role in the breeding system.",
      image,
      attributes: toAttributesArray(def.attributes),
    };

    writeFileSync(outPath, JSON.stringify(metadata, null, 2) + "\n");
    console.log(`Wrote ${outPath}`);
  }

  console.log(
    `\nDone. skipped(live)=${skipped} generated=${generated} untouched(missing keys)=${untouched}${dryRun ? " [dry-run: nothing written]" : ""}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
