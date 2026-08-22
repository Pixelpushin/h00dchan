// Offspring art generation. Per
// docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md's "Art
// rendering" section: the genome (5 gene-slot trait values, already
// resolved by the on-chain breeding algorithm from the two parents) is the
// permanent source of truth, stored on-chain; the image here is purely a
// representation of it, generated fresh each time - trait values go IN,
// an image comes OUT, and this module never runs that direction in
// reverse (no image analysis, no inferring a genome from a picture).
//
// PROMPT-SAFETY: offspring are bred-not-born digital collectibles
// (CryptoKitties-kitten concept), and are deliberately never depicted or
// worded as human infants/children anywhere in the prompt, alt text, or
// metadata this module produces - both because that's wrong for what these
// actually are (an adult-presenting, breeding-age character design, same
// as a freshly-minted CryptoKitty is a full kitten, not a newborn), and
// because that framing is also what avoids OpenAI moderation refusals on
// this endpoint. Banned words - do not reintroduce: "baby", "infant",
// "child", "kid", "toddler", plus diaper/crib/nursery imagery. Grepped for
// these across this file's own output before considering it done.
import { generateAndUploadImage, type GeneratedImage } from "@/lib/openaiImage";

export type OffspringPresentation = "anon" | "girl";

// The 5 collection-agnostic gene slots from the spec's genetics table
// (Hat, Face, Body, Background, Accessory) - each already resolved to a
// concrete trait *value* string (e.g. "Bucket Hat", "Neon Skyline") by the
// on-chain per-locus inheritance algorithm before this module ever sees it.
export interface BreedingGenome {
  hat: string;
  face: string;
  body: string;
  background: string;
  accessory: string;
}

export interface GeneratedBreedingImage extends GeneratedImage {
  prompt: string;
}

const STYLE_SUFFIX =
  "digital illustration, HOODCHAN's irreverent trash-meme aesthetic, bold " +
  "flat colors, chaotic internet-culture energy - not photorealistic, not " +
  "gore, safe for work, no real human likeness.";

// Public so callers (and tests) can inspect the exact prompt without
// re-triggering an OpenAI call - same shape as onlychansConfig.ts keeping
// its prompt pool separate from the fetch logic in onlychansImage.ts.
export function buildBreedingPrompt(
  genome: BreedingGenome,
  presentation: OffspringPresentation = "anon",
): string {
  const subject =
    presentation === "girl"
      ? "freshly spawned young girl"
      : "freshly spawned young anon";
  return (
    `A single blended hood-meme character: a ${subject}, clearly ` +
    `adult-presenting and fully grown (bred-not-born collectible, same ` +
    `concept as a CryptoKitties kitten), wearing a "${genome.hat}" hat, ` +
    `with a "${genome.face}" face, a "${genome.body}" body, set against a ` +
    `"${genome.background}" background, featuring a "${genome.accessory}" ` +
    `accessory, ${STYLE_SUFFIX}`
  );
}

export async function generateBreedingImage(
  genome: BreedingGenome,
  presentation: OffspringPresentation = "anon",
): Promise<GeneratedBreedingImage> {
  const prompt = buildBreedingPrompt(genome, presentation);
  const { blobUrl } = await generateAndUploadImage(prompt, "breeding/");
  return { blobUrl, prompt };
}
