// Central config for the breeding mini-app. Every breeding-specific
// contract address is an env var, never hardcoded - none of the three
// (Girlfriends, Babies, BreedingController) are deployed yet, so every
// address here starts undefined and every page/route that needs one must
// treat that as a real, expected state ("contracts pending deployment"),
// not an error to crash on. Same self-contained convention as the parent
// h00dchan app's lib/chain.ts (raw JSON-RPC, no provider SDK) - this file
// intentionally does NOT import anything from outside breeding-app/, since
// this ships as its own separate Vercel project (root directory =
// breeding-app/) with its own domain (fuck.hoodchan.org).

export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID_HEX = "0x1237"; // 4663
export const CHAIN_ID = 4663;
export const BLOCK_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

// Same Alchemy-first-when-configured convention as the parent app's
// lib/chain.ts's DEFAULT_RPC_URL - the plain public RPC is documented
// elsewhere in this ecosystem as unreliable under real load.
export const DEFAULT_RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : RPC_URL;

// The existing, already-deployed HOODCHAN collection - matron/sire-eligible
// like every allowlisted collection (see the design spec's "no collection
// is restricted to a role" rule) - a real, live address, not an env var,
// since it's not something a human will ever redeploy or swap out from
// under this app. Matches contracts/script/Deploy.s.sol's HOODCHAN
// constant exactly.
export const HOODCHAN_CONTRACT = "0x774Db2207D26570F5638028839c816702A40aBC2";

// CHAN ERC-20, also already deployed - the ONLY fee currency for both the
// birth fee and any siring fee (the v1 dual-currency ETH path is cut from
// scope, see the design spec's "Explicitly cut from scope" section).
// Matches contracts/script/Deploy.s.sol's CHAN_TOKEN constant exactly.
export const CHAN_TOKEN_ADDRESS = "0xB36fD5d3392C78E70c3E08f46b46F242e7EF654F";

// --- Not deployed yet - every one of these is genuinely undefined today ---

// Dummy placeholder collection (~12 tokens, see lib/girlfriendsData.ts
// and data/girlfriends/) - matron/sire-eligible like any other allowlisted
// collection. Swappable for the real team's Girlfriends contract once it
// ships, purely via this env var.
export const GIRLFRIENDS_CONTRACT =
  process.env.NEXT_PUBLIC_GIRLFRIENDS_CONTRACT;

// Mint-on-breed-only offspring collection. TBA-enabled, same
// @pixelpushin/tba-kit registry/implementation as HOODCHAN itself.
export const BABIES_CONTRACT = process.env.NEXT_PUBLIC_BABIES_CONTRACT;

// Owns the siring listings + the single-transaction breed() entry point
// (see contracts/src/BreedingController.sol's ACCEPTED TRADEOFF note for
// why breeding is one atomic call now, not the superseded v1
// commitBreed()/revealBreed() two-step - "you get what you get" is a
// deliberate design choice, not a missing feature).
export const BREEDING_CONTROLLER_CONTRACT =
  process.env.NEXT_PUBLIC_BREEDING_CONTROLLER_CONTRACT;

// --- Fee-recipient addresses (owner-settable post-deploy, see
// BreedingController.setBurnAddress/setMultisig) - env-driven placeholders
// like the three contract addresses above, not fixed values: the design
// spec's "Open questions" section explicitly defers real recipient
// addresses pending a real deploy. Once BreedingController is deployed,
// prefer a LIVE read of its `burnAddress()`/`multisig()` getters over
// these env vars wherever the exact current value matters (they can be
// changed post-deploy without a redeploy) - these exist for pre-deploy
// previews/UI copy only. ---
export const BURN_ADDRESS = process.env.NEXT_PUBLIC_BURN_ADDRESS;
export const MULTISIG_ADDRESS = process.env.NEXT_PUBLIC_MULTISIG_ADDRESS;

// --- Fee amounts - mirror contracts/script/Deploy.s.sol's
// DEFAULT_BIRTH_FEE / DEFAULT_SAME_SEX_FEE_MULTIPLIER constants exactly.
// Both are owner-configurable post-deploy (setBirthFee/
// setSameSexFeeMultiplier), so these constants are display-only fallbacks
// now: app/api/fees/route.ts's live `birthFee()`/`sameSexFeeMultiplier()`
// read (via lib/breedingController.ts's readBirthFee/
// readSameSexFeeMultiplier) is the actual source of truth for both the fee
// preview and the CHAN approval amount on the breed page - these values are
// used ONLY as a loading-state display fallback before that live read
// resolves, never as the approved/debited amount. ---
export const DEFAULT_BIRTH_FEE = 100_000_000_000_000_000_000n; // 100 CHAN, 18 decimals
export const DEFAULT_SAME_SEX_FEE_MULTIPLIER = 2n; // "test tube baby" pays 2x birth fee

// --- Siring protocol-fee split, in basis-points-of-10000 - mirrors
// BreedingController._collectSiringFee's hardcoded arithmetic exactly
// (`(price * 500) / 10000` burn, `(price * 300) / 10000` multisig). These
// ARE true contract constants (not constructor/owner-configurable), unlike
// the fee amounts above, so this mirror can't drift the way those can.
// Applies ONLY to the siring-fee portion (borrowing someone else's sire) -
// never to the flat birth fee, and never when self-siring. ---
export const SIRING_BURN_FEE_BPS = 500n; // 5%
export const SIRING_MULTISIG_FEE_BPS = 300n; // 3%
export const SIRING_PROTOCOL_FEE_BPS =
  SIRING_BURN_FEE_BPS + SIRING_MULTISIG_FEE_BPS; // 8% total
export const FEE_BPS_DENOMINATOR = 10000n;

// --- Escalating per-token cooldown ladder, in SECONDS - mirrors
// BreedingController._cooldownSeconds's hardcoded 14-entry array exactly
// (roughly-doubling: 1min..7day, permanently capped at the last entry for
// any breedCount >= 14). A true contract constant, not owner-configurable,
// same "can't drift" note as the fee-split bps above. ---
export const COOLDOWN_SECONDS_LADDER = [
  60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 57600, 86400, 172800,
  345600, 604800,
] as const;

/** Mirrors `BreedingController._cooldownSeconds(breedCount)` - the
 * escalating cooldown, in seconds, that applies to a token's NEXT breed
 * given its current `breedCount`. Indices past the ladder's length are
 * clamped to the last (7-day) entry, matching the contract's own
 * `breedCount >= ladder.length ? ladder.length - 1 : breedCount` clamp. */
export function cooldownSecondsForBreedCount(breedCount: number): number {
  const idx =
    breedCount >= COOLDOWN_SECONDS_LADDER.length
      ? COOLDOWN_SECONDS_LADDER.length - 1
      : breedCount;
  return COOLDOWN_SECONDS_LADDER[idx];
}

export interface ContractStatus {
  girlfriends: boolean;
  babies: boolean;
  breedingController: boolean;
  allDeployed: boolean;
}

// Single source of truth for "are the breeding contracts live yet" - every
// page checks this and renders a "contracts pending deployment" state
// instead of attempting reads/writes against an undefined address (which
// would otherwise throw deep inside an eth_call and look like a bug rather
// than the expected pre-launch state).
export function getContractStatus(): ContractStatus {
  const girlfriends = Boolean(GIRLFRIENDS_CONTRACT);
  const babies = Boolean(BABIES_CONTRACT);
  const breedingController = Boolean(BREEDING_CONTROLLER_CONTRACT);
  return {
    girlfriends,
    babies,
    breedingController,
    allDeployed: girlfriends && babies && breedingController,
  };
}
