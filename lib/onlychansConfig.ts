// onlyChans: a holder-gated feed where only the AI posts, and every post
// is a deliberately janky, uncanny-valley "AI art fail" image in the spirit
// of the early-2020s DALL-E-mini/Midjourney-v1 era - too many toes, warped
// anatomy, waxy textures, nonsense proportions. Satire of bad AI art, not
// anatomically real or sexual content - every prompt below leans into the
// "obviously fake, obviously funny, unmistakably a computer's mistake"
// register on purpose, and OpenAI's own image-generation content policy is
// the backstop if any specific phrasing drifts.
export const IMAGE_MODEL = "gpt-image-1";
export const IMAGE_SIZE = "1024x1024";
// "low" keeps cost down (this is a joke feature, not the main product) and
// happens to look more uncanny/artifact-heavy anyway - fits the bit.
export const IMAGE_QUALITY = "low";

const STYLE_SUFFIX =
  "digital illustration, obviously AI-generated, uncanny valley, dated " +
  "2022-era AI-art-generator aesthetic, waxy plastic texture, nonsense " +
  "anatomy, artifact-heavy, low fidelity, surreal and comedic - not " +
  "photorealistic, not gore, safe for work, no real human likeness.";

export const PROMPT_POOL: string[] = [
  `A human foot with nine mismatched toes fused together at odd angles, ${STYLE_SUFFIX}`,
  `A foot where the toenails are tiny human teeth, ${STYLE_SUFFIX}`,
  `Two feet growing out of a single ankle at the wrong angle, ${STYLE_SUFFIX}`,
  `A foot slowly melting into a sneaker that doesn't have the right number of holes, ${STYLE_SUFFIX}`,
  `A foot with a second, smaller foot growing out of the heel, ${STYLE_SUFFIX}`,
  `A foot made of what might be bread, with toes that don't quite connect to anything, ${STYLE_SUFFIX}`,
  `A foot with way too many joints, bending in directions a foot shouldn't bend, ${STYLE_SUFFIX}`,
  `A foot wearing a sock that has its own extra foot-shaped bulge on the side, ${STYLE_SUFFIX}`,
  `A foot with an eye where the ankle should be, staring at nothing, ${STYLE_SUFFIX}`,
  `A foot with toes that are each a slightly different species of toe, ${STYLE_SUFFIX}`,
  `A foot standing on a beach, except the sand is also, somehow, made of feet, ${STYLE_SUFFIX}`,
  `A foot holding a smaller foot like it's a hand holding a phone, ${STYLE_SUFFIX}`,
];

export function randomPrompt(): string {
  return PROMPT_POOL[Math.floor(Math.random() * PROMPT_POOL.length)];
}

// Each post's caption - deliberately OnlyFans-thirst-trap-marketing-copy
// energy applied to the deformed AI feet above it, not a description of
// the image or the literal generation prompt (never shown - see
// app/onlychans/page.tsx). The joke is entirely in the mismatch: the
// breathless "unlock more" cadence next to something nobody asked to see.
// Static pool, not a second per-post LLM call - free, and the bit doesn't
// need real variety beyond "pick a different flavor of unhinged" each time.
export const CAPTION_POOL: string[] = [
  "you weren't ready for this drop. full gallery unlocked for verified anons only 🔒",
  "POV: you slid into my DMs and I sent... this. no refunds, no cap.",
  "3,214 anons have already seen this. you could be next 👣",
  "this took the clanker 0.4 seconds to generate and you're still staring at it",
  "welcome to the only feed that's 100% real fake content",
  "like & activate your wallet for more (I genuinely have no idea what I'm doing)",
  "not gatekeeping, just chain-gatekeeping 🔐",
  "certified clanker-made. zero human touch, all the way through.",
  "if you know you know. you don't know. nobody knows.",
  "exclusive content for my top 1197 supporters 💕 (there are exactly 1197 of you)",
  "drop your wallet address below for a personalized foot (I will not do this)",
  "subscribe to see what's REALLY inside this sneaker",
  "the algorithm chose violence today and honestly? respect",
  "this is what your $CHAN bag actually looks like under a microscope",
  "manifesting more toes in 2027",
];

export function randomCaption(): string {
  return CAPTION_POOL[Math.floor(Math.random() * CAPTION_POOL.length)];
}
