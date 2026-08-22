// Trait definitions for the 12 dummy HOODCHAN_GIRLFRIENDS tokens - defined
// FIRST, independent of art generation, matching hoodchan.website's live
// "HOODCHAN GIRL" generator's trait_type shape (Backgrounds, Bodies, Faces,
// Grills, Hats, Girl Stuff) confirmed against the real site. This is also
// what confirms the spec's gene-slot mapping is sound: HOODCHAN's own
// Hats/Faces/Bodies/Backgrounds/Extra line up 1:1 against this collection's
// Hats/Faces/Bodies/Backgrounds/Girl Stuff.
//
// scripts/generate-girlfriends.ts reads this array to drive both the image
// prompt (lib/girlfriendsImage.ts) and the final ERC-721 metadata JSON -
// this file is the single source of truth for "what token #N looks like",
// not something inferred after the fact from a generated image.
export interface GirlfriendAttributes {
  backgrounds: string;
  bodies: string;
  faces: string;
  grills: string;
  hats: string;
  girlStuff: string;
}

export interface GirlfriendDefinition {
  tokenId: number;
  name: string;
  attributes: GirlfriendAttributes;
}

export const GIRLFRIEND_DEFINITIONS: GirlfriendDefinition[] = [
  {
    tokenId: 1,
    name: "Girlfriend #1",
    attributes: {
      backgrounds: "Neon Skyline",
      bodies: "Tracksuit Hourglass",
      faces: "Smirk with Freckles",
      grills: "Gold Top Row",
      hats: "Durag",
      girlStuff: "Hoop Earrings + Fanny Pack",
    },
  },
  {
    tokenId: 2,
    name: "Girlfriend #2",
    attributes: {
      backgrounds: "Corner Store Awning",
      bodies: "Oversized Hoodie",
      faces: "Side-Eye Smoky Liner",
      grills: "Diamond Fangs",
      hats: "Bucket Hat",
      girlStuff: "Long Lace-Front Wig + Chain Belt",
    },
  },
  {
    tokenId: 3,
    name: "Girlfriend #3",
    attributes: {
      backgrounds: "Purple Trap House",
      bodies: "Bodycon Dress",
      faces: "Winged Liner + Lip Gloss",
      grills: "Platinum Bottom Row",
      hats: "Baseball Cap Backwards",
      girlStuff: "Bamboo Hoops + Nail Set",
    },
  },
  {
    tokenId: 4,
    name: "Girlfriend #4",
    attributes: {
      backgrounds: "Cracked Basketball Court",
      bodies: "Varsity Jacket",
      faces: "Gap Tooth Grin",
      grills: "Rose Gold Fangs",
      hats: "Beanie",
      girlStuff: "Box Braids + Chunky Chain",
    },
  },
  {
    tokenId: 5,
    name: "Girlfriend #5",
    attributes: {
      backgrounds: "Bodega Neon Sign",
      bodies: "Crop Top + Cargo Pants",
      faces: "Cat-Eye Sunglasses",
      grills: "Iced-Out Full Set",
      hats: "Silk Bonnet",
      girlStuff: "Acrylic Nails + Wrist Bag",
    },
  },
  {
    tokenId: 6,
    name: "Girlfriend #6",
    attributes: {
      backgrounds: "Rooftop at Dusk",
      bodies: "Leather Jacket",
      faces: "Bold Brows + Nose Ring",
      grills: "Gold Fangs",
      hats: "Snapback",
      girlStuff: "Half-Up Space Buns + Chain Necklace",
    },
  },
  {
    tokenId: 7,
    name: "Girlfriend #7",
    attributes: {
      backgrounds: "Arcade Cabinet Glow",
      bodies: "Denim-on-Denim",
      faces: "Freckles + Septum Ring",
      grills: "Silver Top Row",
      hats: "Trucker Cap",
      girlStuff: "Pigtails + Chunky Hoops",
    },
  },
  {
    tokenId: 8,
    name: "Girlfriend #8",
    attributes: {
      backgrounds: "Gas Station at Night",
      bodies: "Puffer Vest",
      faces: "Smoky Eye + Beauty Mark",
      grills: "Diamond Top Row",
      hats: "Fitted Cap Sideways",
      girlStuff: "Waist-Length Wig + Layered Chains",
    },
  },
  {
    tokenId: 9,
    name: "Girlfriend #9",
    attributes: {
      backgrounds: "Chain-Link Fence Sunset",
      bodies: "Sweatsuit Set",
      faces: "Sharp Winged Liner",
      grills: "Gold Full Set",
      hats: "Do-Rag Under Cap",
      girlStuff: "French Tips + Belt Bag",
    },
  },
  {
    tokenId: 10,
    name: "Girlfriend #10",
    attributes: {
      backgrounds: "Block Party Streamers",
      bodies: "Halter Top + Track Pants",
      faces: "Glitter Eyeshadow",
      grills: "Rose Gold Top Row",
      hats: "Visor",
      girlStuff: "Curly Afro Puff + Statement Earrings",
    },
  },
  {
    tokenId: 11,
    name: "Girlfriend #11",
    attributes: {
      backgrounds: "Subway Platform Tile",
      bodies: "Cropped Puffer",
      faces: "Bold Red Lip",
      grills: "Platinum Fangs",
      hats: "Knit Cap",
      girlStuff: "Sleek Ponytail + Layered Rings",
    },
  },
  {
    tokenId: 12,
    name: "Girlfriend #12",
    attributes: {
      backgrounds: "Sunset Boardwalk",
      bodies: "Mesh Overlay Top",
      faces: "Colored Contacts + Nose Stud",
      grills: "Iced Bottom Row",
      hats: "Flat Brim Cap",
      girlStuff: "Twin French Braids + Hoop Belt Chain",
    },
  },
];
