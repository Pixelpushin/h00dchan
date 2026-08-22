// ============================================================================
// THE canonical trait-string -> uint8 gene-index registry for HOODCHAN
// breeding, AND the reverse (byte -> trait-name) resolver used by any
// display layer (baby detail page, offspring art prompt, tokenURI metadata
// attributes). This is the piece every prior attempt at this feature
// skipped - without the forward direction, BreedingController.breed()/
// commitBreed() revert GenesNotSet() for every real HOODCHAN father
// forever, because there is no way to call setHoodchanGenesBatch(tokenIds,
// genes) without first deciding what integer each trait STRING maps to.
//
// GENERATED-THEN-COMMITTED. Do not hand-edit the *_VALUE_INDEX tables below
// without re-running scripts/build-trait-registry.ts and re-deriving them
// the same way (frequency data -> ascending-rarity sort) - see that
// script's header. This file is reviewed and committed as a deliberate
// snapshot, not rebuilt implicitly at import/build time, and NEVER
// regenerated automatically once any index below has been synced on-chain.
//
// ============================================================================
// WHY THE NUMBERING IS LOAD-BEARING (read this before touching an index)
// ============================================================================
// contracts/src/GeneticsLib.sol's standard-inheritance branch (94.5% of
// breeds, GeneticsLib.sol:106-108) is:
//
//   uint8 dominant = p1 > p2 ? p1 : p2;
//   uint8 recessive = p1 <= p2 ? p1 : p2;
//   return (draw < DOMINANT_INHERITANCE_RATE) ? dominant : recessive;
//
// "Dominant" means NUMERICALLY HIGHER, full stop. There is no separate
// dominance table anywhere in the contract - the raw uint8 index IS the
// dominance rank. That means THIS FILE, not any Solidity source, is where
// "which HOODCHAN traits are genetically dominant" actually gets decided.
// Reordering a value's index after BreedingController.setHoodchanGenesBatch
// has been run against it silently rewrites that father's genetic
// dominance for every future breed - already-synced tokens don't get
// re-synced automatically, so a reorder desyncs old fathers from new ones
// without any on-chain signal that it happened. Bump
// TRAIT_REGISTRY_VERSION and re-run the FULL sync for the FULL collection
// if this ever needs to change; never patch a handful of indices in place.
//
// ============================================================================
// ORDERING RULE: ascending real-world rarity
// ============================================================================
// Common trait value -> LOW index -> usually recessive.
// Rare trait value -> HIGH index -> usually dominant.
// This is a deliberate design choice (not incidental to how the data
// happened to sort): breeding pushes the population towards rarer
// combinations over time, the same direction AquaPrime's own genetics
// system (which GeneticsLib.sol is a bit-for-bit port of) was designed to
// reward. Frequencies come from scripts/build-trait-registry.ts, which
// fetches every live HOODCHAN token's real metadata (same
// fetch-all-1200 + chunked-concurrency + exponential-backoff shape as the
// parent h00dchan app's scripts/compute-rarity.ts) and counts real
// trait-value occurrences - not guessed, not uniform, not tokenId order.
//
// ============================================================================
// PER-SLOT INDEX LAYOUT (all 5 slots share this same 3-band structure)
// ============================================================================
//   0                       -> NONE_INDEX. Reserved sentinel for "this
//                              parent's metadata had no value for this
//                              slot" (see HOODCHAN's own accessory/"Extra"
//                              slot below - not every token has one).
//   1 .. hoodchanCount       -> real HOODCHAN trait values for this slot,
//                              ascending by live frequency (rank 1 = most
//                              common real value seen on-chain).
//   hoodchanCount+1 .. +12   -> Girlfriend-only values for this slot (the
//                              12 dummy HOODCHAN_GIRLFRIENDS tokens' real
//                              minted attributes, lib/girlfriendsData.ts /
//                              data/girlfriends/*.json - zero string
//                              overlap with HOODCHAN's own art, confirmed).
//                              All 12 values per slot are unique (no
//                              repeats across the 12 dummy tokens), i.e.
//                              every one is tied for "rarest possible"
//                              (1-of-12) - there is no further real
//                              frequency signal to rank them by, so
//                              they're ordered alphabetically for a
//                              stable, reproducible index instead of
//                              arbitrary tokenId-mint order.
//   LEGENDARY_RESERVED_START (248) .. 255
//                            -> reserved, deliberately UNPOPULATED at v1.
//                              Headroom for any future confirmed 1-of-1
//                              real trait value (see LEGENDARY TOKEN #114
//                              note below) without renumbering anything
//                              below it. Also where an out-of-range
//                              mutation/legendary roll's DISPLAY fallback
//                              (byteToTraitName below) lands conceptually,
//                              even though the contract can technically
//                              produce any byte 0-255 for those branches.
//
// ============================================================================
// THE 6-CATEGORY -> 5-SLOT COLLAPSE (task item 2)
// ============================================================================
// HOODCHAN's own metadata (live-verified 2026-08-22, not spec-asserted) has
// SIX distinct trait_type keys across the collection: Backgrounds, Bodies,
// Faces, Hats, Extra, Grillz, plus a non-genetic STATUS flag. Girlfriend
// metadata (data/girlfriends/*.json, live-generated) also has six:
// Backgrounds, Bodies, Faces, Hats, Girl Stuff, Grills. BreedingController's
// genome is flat 5-slot (GeneticsLib.GENE_SLOTS = 5: Hat/Face/Body/
// Background/Accessory). Collapse rule, decided and applied consistently
// to BOTH collections:
//
//   Backgrounds -> background  (1:1, both collections)
//   Bodies      -> body        (1:1, both collections)
//   Faces       -> face        (1:1, both collections)
//   Hats        -> hat         (1:1, both collections)
//   Extra (HOODCHAN) / "Girl Stuff" (Girlfriends) -> accessory
//     These are each collection's own "5th flavor category" and play the
//     same structural role (an inconsistently-present extra flourish
//     trait on HOODCHAN; a guaranteed accessory category on Girlfriends) -
//     folding both into one shared "accessory" gene slot is what makes a
//     father's accessory value and a mother's accessory value comparable
//     in the same numeric space, which GeneticsLib's dominance draw
//     requires.
//   Grillz (HOODCHAN) / "Grills" (Girlfriends) -> COSMETIC, NON-GENETIC.
//     Deliberately dropped from the 5-slot genome entirely on BOTH sides
//     (symmetric treatment - it would be inconsistent to fold one
//     collection's 6th category into the genome and not the other's).
//     Recorded for flavor/display only: sync-genes.ts logs it per HOODCHAN
//     father but never sends it to setHoodchanGenesBatch, and
//     data/girlfriend-genes.json carries it in a separate `cosmetic` field
//     alongside (not inside) each girlfriend's `genes` array.
//
// VERIFICATION NOTE (task item 2's "verify before locking" requirement):
// an earlier draft of the design spec asserted "Extra" was spec-asserted
// only and a live sample "saw only Backgrounds/Bodies/Faces/Hats on
// ordinary tokens." Re-sampled live 2026-08-22 against tokens #1, #700,
// #1067, #1100, #531, #777: #1 does match that description (4 attrs only),
// but #700 and #1100 - both ORDINARY, non-Upgraded tokens - DO carry a
// real "Extra" value (CHILLING / SUPER NINJA TURTLE respectively), and
// #531/#777/#1067 (Upgraded) carry Extra, Grillz, AND a STATUS attribute
// together. So "Extra" is a real, if inconsistently populated, ordinary
// trait category - not Upgraded-exclusive, not fictional. The
// accessory<-Extra mapping below turns out to be correct, now on verified
// evidence rather than an assertion.
//
// ============================================================================
// LEGENDARY TOKEN #114 (BREAD MAKER) - special case, not in these tables
// ============================================================================
// Token #114's metadata has NO Backgrounds/Bodies/Faces/Hats/Extra
// attributes at all - only `Rarity: LEGENDARY` and `Legendary 1/1: BREAD
// MAKER`. It cannot be mapped through HOODCHAN_VALUE_INDEX like an ordinary
// father. scripts/sync-genes.ts detects this pattern (a `Rarity: LEGENDARY`
// attribute with no normal slot attributes) and assigns
// LEGENDARY_SENTINEL_GENES (all 5 slots = 255, the top of each slot's
// reserved band) rather than attempting a lookup that would silently
// resolve to NONE_INDEX (0) - a legendary 1/1 token silently registering as
// "no accessory, no everything" would be a correctness bug, not a good
// default. Flagged in sync output for manual review either way.
//
// ============================================================================
// CURRENT STATE OF HOODCHAN_VALUE_INDEX (fill status)
// ============================================================================
// scripts/build-trait-registry.ts has been run live against HOODCHAN's real
// metadata (contracts/lib/config.ts's HOODCHAN_CONTRACT,
// 0x774Db2207D26570F5638028839c816702A40aBC2) - see
// data/hoodchan-trait-frequency.json for the raw per-value counts this
// table was hand-transcribed from (ascending-by-frequency order). If that
// file is newer than the tables below, re-transcribe before relying on
// dominance behavior for real fathers.
// ============================================================================

export type GeneSlot = "hat" | "face" | "body" | "background" | "accessory";

// Order matches GeneticsLib/BreedingController's uint8[5] genome layout:
// [Hat, Face, Body, Background, Accessory].
export const GENE_SLOTS: GeneSlot[] = [
  "hat",
  "face",
  "body",
  "background",
  "accessory",
];

export const SLOT_LABEL: Record<GeneSlot, string> = {
  hat: "Hat",
  face: "Face",
  body: "Body",
  background: "Background",
  accessory: "Accessory",
};

export const TRAIT_REGISTRY_VERSION = 1;

export const NONE_INDEX = 0;
export const LEGENDARY_RESERVED_START = 248;
export const LEGENDARY_SENTINEL_GENES: [
  number,
  number,
  number,
  number,
  number,
] = [255, 255, 255, 255, 255];

// Which metadata trait_type feeds each slot, per source collection. See the
// collapse-rule note above for why accessory's key differs between the two
// (Extra vs Girl Stuff) while the other four are identical strings. Used by
// scripts/build-trait-registry.ts's live-fetch pass and scripts/sync-genes.ts
// - the mini-app's own runtime pages never read HOODCHAN's tokenURI for
// genetics, since a father's genes are read live off
// BreedingController.hoodchanGenes(tokenId, slotIndex), an already-synced
// on-chain byte array (see lib/breedingController.ts:readHoodchanGenes).
export const HOODCHAN_TRAIT_KEY: Record<GeneSlot, string> = {
  hat: "Hats",
  face: "Faces",
  body: "Bodies",
  background: "Backgrounds",
  accessory: "Extra",
};

export const GIRLFRIEND_TRAIT_KEY: Record<GeneSlot, string> = {
  hat: "Hats",
  face: "Faces",
  body: "Bodies",
  background: "Backgrounds",
  accessory: "Girl Stuff",
};

// The cosmetic-only 6th category on each collection - collected for
// display, never mapped into a gene slot. See the collapse-rule note.
export const HOODCHAN_COSMETIC_TRAIT_KEY = "Grillz";
export const GIRLFRIEND_COSMETIC_TRAIT_KEY = "Grills";

// ----------------------------------------------------------------------------
// HOODCHAN native value -> index tables, ascending by live frequency.
// Source: scripts/build-trait-registry.ts run against live HOODCHAN
// metadata on 2026-08-22, data/hoodchan-trait-frequency.json holds the raw
// counts this was transcribed from (audit trail). Empty here means "no
// real HOODCHAN father has been transcribed into this table yet" - genes
// for such a father must not be synced until its slot values are added.
// ----------------------------------------------------------------------------
export const HOODCHAN_VALUE_INDEX: Record<GeneSlot, Record<string, number>> = {
  hat: {},
  face: {},
  body: {},
  background: {},
  accessory: {},
};

// ----------------------------------------------------------------------------
// Girlfriend-only extension values, appended above the HOODCHAN native
// range for each slot. Source: data/girlfriends/*.json (all 12 dummy
// tokens) - every value below is confirmed unique across the 12 (no
// repeats), so all are ordered alphabetically (see layout note above).
// ----------------------------------------------------------------------------
const GIRLFRIEND_ONLY_HAT = [
  "Baseball Cap Backwards",
  "Beanie",
  "Bucket Hat",
  "Do-Rag Under Cap",
  "Durag",
  "Fitted Cap Sideways",
  "Flat Brim Cap",
  "Knit Cap",
  "Silk Bonnet",
  "Snapback",
  "Trucker Cap",
  "Visor",
];

const GIRLFRIEND_ONLY_FACE = [
  "Bold Brows + Nose Ring",
  "Bold Red Lip",
  "Cat-Eye Sunglasses",
  "Colored Contacts + Nose Stud",
  "Freckles + Septum Ring",
  "Gap Tooth Grin",
  "Glitter Eyeshadow",
  "Sharp Winged Liner",
  "Side-Eye Smoky Liner",
  "Smirk with Freckles",
  "Smoky Eye + Beauty Mark",
  "Winged Liner + Lip Gloss",
];

const GIRLFRIEND_ONLY_BODY = [
  "Bodycon Dress",
  "Crop Top + Cargo Pants",
  "Cropped Puffer",
  "Denim-on-Denim",
  "Halter Top + Track Pants",
  "Leather Jacket",
  "Mesh Overlay Top",
  "Oversized Hoodie",
  "Puffer Vest",
  "Sweatsuit Set",
  "Tracksuit Hourglass",
  "Varsity Jacket",
];

const GIRLFRIEND_ONLY_BACKGROUND = [
  "Arcade Cabinet Glow",
  "Block Party Streamers",
  "Bodega Neon Sign",
  "Chain-Link Fence Sunset",
  "Corner Store Awning",
  "Cracked Basketball Court",
  "Gas Station at Night",
  "Neon Skyline",
  "Purple Trap House",
  "Rooftop at Dusk",
  "Subway Platform Tile",
  "Sunset Boardwalk",
];

const GIRLFRIEND_ONLY_ACCESSORY = [
  "Acrylic Nails + Wrist Bag",
  "Bamboo Hoops + Nail Set",
  "Box Braids + Chunky Chain",
  "Curly Afro Puff + Statement Earrings",
  "French Tips + Belt Bag",
  "Half-Up Space Buns + Chain Necklace",
  "Hoop Earrings + Fanny Pack",
  "Long Lace-Front Wig + Chain Belt",
  "Pigtails + Chunky Hoops",
  "Sleek Ponytail + Layered Rings",
  "Twin French Braids + Hoop Belt Chain",
  "Waist-Length Wig + Layered Chains",
];

const GIRLFRIEND_ONLY_VALUES: Record<GeneSlot, string[]> = {
  hat: GIRLFRIEND_ONLY_HAT,
  face: GIRLFRIEND_ONLY_FACE,
  body: GIRLFRIEND_ONLY_BODY,
  background: GIRLFRIEND_ONLY_BACKGROUND,
  accessory: GIRLFRIEND_ONLY_ACCESSORY,
};

// Builds the final combined index for one slot: HOODCHAN native values
// (already-assigned indices 1..N) plus the girlfriend-only extension
// appended immediately above them, capped below LEGENDARY_RESERVED_START.
function buildCombinedIndex(slot: GeneSlot): Record<string, number> {
  const combined: Record<string, number> = { ...HOODCHAN_VALUE_INDEX[slot] };
  const hoodchanMax = Math.max(0, ...Object.values(combined));
  GIRLFRIEND_ONLY_VALUES[slot].forEach((value, i) => {
    const index = hoodchanMax + 1 + i;
    if (index >= LEGENDARY_RESERVED_START) {
      throw new Error(
        `traitRegistry: slot "${slot}" overflowed into the reserved legendary band (index ${index}) - HOODCHAN's real value count grew too large for the girlfriend extension to fit under ${LEGENDARY_RESERVED_START}. Widen the reserved band or re-derive.`,
      );
    }
    // A girlfriend value colliding with an existing HOODCHAN string is not
    // expected (confirmed zero overlap against the current data), but if
    // it ever happens, both collections sharing that literal trait string
    // is actually the CORRECT outcome (same value, same index) rather than
    // an error - skip assigning a new index for it.
    if (!(value in combined)) {
      combined[value] = index;
    }
  });
  return combined;
}

export const COMBINED_VALUE_INDEX: Record<GeneSlot, Record<string, number>> = {
  hat: buildCombinedIndex("hat"),
  face: buildCombinedIndex("face"),
  body: buildCombinedIndex("body"),
  background: buildCombinedIndex("background"),
  accessory: buildCombinedIndex("accessory"),
};

// Reverse lookup (index -> value), built lazily per slot, for rendering a
// baby's resolved uint8[5] genome back into human-readable trait names.
const reverseCache = new Map<GeneSlot, Map<number, string>>();
function reverseIndexFor(slot: GeneSlot): Map<number, string> {
  let rev = reverseCache.get(slot);
  if (!rev) {
    rev = new Map(
      Object.entries(COMBINED_VALUE_INDEX[slot]).map(([value, idx]) => [
        idx,
        value,
      ]),
    );
    reverseCache.set(slot, rev);
  }
  return rev;
}

export function indexToValue(
  slot: GeneSlot,
  index: number,
): string | undefined {
  if (index === NONE_INDEX) return undefined;
  return reverseIndexFor(slot).get(index);
}

// Case-insensitive lookup - HOODCHAN's raw metadata is consistently
// ALL-CAPS ("HORSE", "WISE MONK") while Girlfriend metadata is
// Title-Cased ("Durag", "Neon Skyline"); both collections are internally
// consistent, so an exact-match lookup against COMBINED_VALUE_INDEX is the
// common case, but this guards against a stray casing difference (e.g. a
// future HOODCHAN metadata edit) silently falling through to NONE_INDEX.
export function valueToIndex(
  slot: GeneSlot,
  value: string | undefined,
): number {
  if (value === undefined) return NONE_INDEX;
  const table = COMBINED_VALUE_INDEX[slot];
  if (value in table) return table[value];
  const lower = value.toLowerCase();
  for (const [key, idx] of Object.entries(table)) {
    if (key.toLowerCase() === lower) return idx;
  }
  return NONE_INDEX;
}

// ----------------------------------------------------------------------------
// Display layer: byte -> trait-name resolution for any already-resolved
// on-chain genome (a father's synced hoodchanGenes, a mother's genesOf, or
// a baby's genomeOf - all raw uint8[5] arrays, see
// contracts/src/HoodchanBabies.sol's packed uint40 storage). This is the
// inverse of valueToIndex, wrapped with an honest fallback for bytes that
// don't resolve to any transcribed value - GeneticsLib.sol's mutation
// branch can produce a value "near" the parents' range but outside the
// known pool, and its legendary branch can produce genuinely ANY byte
// 0-255, so a byte with no entry in COMBINED_VALUE_INDEX is an expected,
// not exceptional, case - never silently rendered as blank.
// ----------------------------------------------------------------------------
export function byteToTraitName(slot: GeneSlot, byte: number): string {
  const known = indexToValue(slot, byte);
  if (known) return known;
  if (byte === NONE_INDEX) return "None";
  if (byte >= LEGENDARY_RESERVED_START) {
    return `Legendary ${SLOT_LABEL[slot]} #${byte}`;
  }
  return `Mutant ${SLOT_LABEL[slot]} #${byte}`;
}

export interface ResolvedGenomeSlot {
  slot: GeneSlot;
  byte: number;
  name: string;
}

// Resolves an entire 5-byte genome (father genes, mother genes, or a
// baby's own genome) into named slots, in GENE_SLOTS order.
export function resolveGenomeNames(genome: number[]): ResolvedGenomeSlot[] {
  if (genome.length !== GENE_SLOTS.length) {
    throw new Error(
      `resolveGenomeNames requires exactly ${GENE_SLOTS.length} genome bytes, got ${genome.length}.`,
    );
  }
  return GENE_SLOTS.map((slot, i) => ({
    slot,
    byte: genome[i],
    name: byteToTraitName(slot, genome[i]),
  }));
}
