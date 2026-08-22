// Art generation for the dummy HOODCHAN_GIRLFRIENDS collection (see spec's
// "Dummy Girlfriends collection" section) - 12 throwaway placeholder tokens
// generated via the same OpenAI pipeline as lib/breedingImage.ts, prompted
// to match hoodchan.website's live "HOODCHAN GIRL" generator: adult women,
// wigs, jewelry, hood-girl meme aesthetic, described/illustrative style
// (NOT pixel art) - same irreverent tone as HOODCHAN itself. Swapped for
// the real team's collection once it ships (lib/config.ts already reads
// the contract address from env, not hardcoded, for exactly that reason).
import { generateAndUploadImage, type GeneratedImage } from "@/lib/openaiImage";
import type { GirlfriendAttributes } from "@/lib/girlfriendsData";

export interface GeneratedGirlfriendImage extends GeneratedImage {
  prompt: string;
}

const STYLE_SUFFIX =
  "digital illustration, described/illustrative art style (not pixel " +
  "art), HOODCHAN's irreverent hood-meme aesthetic, bold flat colors - " +
  "not photorealistic, not gore, not explicit, safe for work, no real " +
  "human likeness.";

export function buildGirlfriendPrompt(attrs: GirlfriendAttributes): string {
  return (
    `A single adult woman character portrait for a hood-meme NFT ` +
    `collection, set against a "${attrs.backgrounds}" background, with a ` +
    `"${attrs.bodies}" body, a "${attrs.faces}" face, "${attrs.grills}" ` +
    `grills, wearing "${attrs.hats}" and "${attrs.girlStuff}" (wigs, ` +
    `jewelry, hood-girl styling), ${STYLE_SUFFIX}`
  );
}

export async function generateGirlfriendImage(
  attrs: GirlfriendAttributes,
): Promise<GeneratedGirlfriendImage> {
  const prompt = buildGirlfriendPrompt(attrs);
  const { blobUrl } = await generateAndUploadImage(prompt, "girlfriends/");
  return { blobUrl, prompt };
}
