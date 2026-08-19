// Generates a funny, on-brand challenge phrase instead of an ugly hex
// code - same cryptographic role (unpredictable, unique per claim, checked
// verbatim), but reads like something an h00dchan anon would actually
// post, matching the site's own "cartoon NFT confidently wrong about
// invented crypto lore" voice (see lib/ai-persona.ts's system prompt).
// Template-based (SUBJECT + VERB + OBJECT) rather than 3 unrelated random
// words, so it reads as one coherent absurd sentence, not word salad -
// every entry below is a plain noun phrase specifically so ANY
// combination stays grammatically coherent (a parenthetical aside baked
// into one slot reads fine alone but confusing once combined with an
// unrelated verb/object - confirmed live, cut those out).
//
// Always ends with "- hoodchan.org" so the phrase itself carries the
// traffic-driving link, not just the meme text - the whole point of this
// feature is getting the URL in front of the poster's followers, not just
// proving wallet ownership.
//
// Client-safe (no secrets, no randomness that needs to match server-side -
// the actual challenge is generated server-side in lib/bioVerifyStore.ts
// and this file is just the word tables + assembly function it calls).
export const SUBJECTS = [
  "the whale cabal",
  "my clanker",
  "the moon monks",
  "a rogue validator",
  "the rug committee",
  "three anons in a trenchcoat",
  "the boardroom pigeons",
  "my own TBA wallet",
  "the Robinhood Chain illuminati",
  "a suspiciously calm dev",
  "the OpenSea royalties board",
  "a discord mod with no life",
  "the clanker uprising",
  "an anon who's never sold",
  "the gas fee gremlins",
  "a wallet with 12 followers",
  "the anon census bureau",
  "my nested hoodchan",
  "the flipper witness protection program",
];

export const VERBS = [
  "confirmed",
  "leaked",
  "covered up",
  "insider-traded",
  "shorted",
  "manifested",
  "vibe-checked",
  "front-ran",
  "unionized against",
  "livestreamed",
  "quietly deleted",
  "screenshotted",
  "ghost-posted about",
  "subtweeted",
  "staged a coup over",
];

export const OBJECTS = [
  "the moonstone reserve",
  "a rug that wasn't real",
  "the secret roadmap",
  "a fake whitepaper",
  "the anon census",
  "the clanker uprising",
  "the OpenSea royalties",
  "a burner wallet",
  "the top holder crown",
  "a level 2 badge",
  "the nested-holding glitch",
  "the hodler streak leaderboard",
  "a whale's bag",
  "the last activated wallet",
];

const SITE_TAG = "hoodchan.org";

export function assemblePhrase(
  subjectIndex: number,
  verbIndex: number,
  objectIndex: number,
): string {
  const subject = SUBJECTS[subjectIndex % SUBJECTS.length];
  const verb = VERBS[verbIndex % VERBS.length];
  const object = OBJECTS[objectIndex % OBJECTS.length];
  const sentence = `${subject} ${verb} ${object}`;
  const capitalized = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return `${capitalized} - ${SITE_TAG}`;
}

// Total distinct phrases - used to size the random index space server-side.
export const PHRASE_SPACE_SIZE =
  SUBJECTS.length * VERBS.length * OBJECTS.length;

// Mixed-radix decomposition of one random seed in [0, PHRASE_SPACE_SIZE)
// into three independent slot indices - a bijection, so every seed in
// range maps to exactly one phrase and every phrase is reachable. Keeps
// the encoding co-located with the word lists it depends on, rather than
// each caller re-deriving the same math against SUBJECTS.length etc.
export function phraseFromSeed(seed: number): string {
  const subjectIndex = seed % SUBJECTS.length;
  const verbIndex = Math.floor(seed / SUBJECTS.length) % VERBS.length;
  const objectIndex =
    Math.floor(seed / (SUBJECTS.length * VERBS.length)) % OBJECTS.length;
  return assemblePhrase(subjectIndex, verbIndex, objectIndex);
}
