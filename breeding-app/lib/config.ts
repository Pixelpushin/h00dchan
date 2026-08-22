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

// The existing, already-deployed HOODCHAN collection (father role) - a
// real, live address, not an env var, since it's not something a human
// will ever redeploy or swap out from under this app. Matches
// contracts/script/Deploy.s.sol's HOODCHAN constant exactly.
export const HOODCHAN_CONTRACT = "0x774Db2207D26570F5638028839c816702A40aBC2";

// CHAN ERC-20, also already deployed - breeding fees are paid in this
// token for every listing, regardless of Upgraded status. Matches
// contracts/script/Deploy.s.sol's CHAN_TOKEN constant exactly.
export const CHAN_TOKEN_ADDRESS = "0xB36fD5d3392C78E70c3E08f46b46F242e7EF654F";

// --- Not deployed yet - every one of these is genuinely undefined today ---

// Dummy placeholder mother collection (~12 tokens, see lib/girlfriendsData.ts
// and data/girlfriends/). Swappable for the real team's Girlfriends
// contract once it ships, purely via this env var.
export const GIRLFRIENDS_CONTRACT =
  process.env.NEXT_PUBLIC_GIRLFRIENDS_CONTRACT;

// Mint-on-breed-only offspring collection. TBA-enabled, same
// @pixelpushin/tba-kit registry/implementation as HOODCHAN itself.
export const BABIES_CONTRACT = process.env.NEXT_PUBLIC_BABIES_CONTRACT;

// Owns the siring-price listings + commitBreed()/revealBreed() entry
// points (see contracts/src/BreedingController.sol's SEED-FAIRNESS
// MITIGATION note for why breeding is two-step, not a single breed() call).
export const BREEDING_CONTROLLER_CONTRACT =
  process.env.NEXT_PUBLIC_BREEDING_CONTROLLER_CONTRACT;

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

// Nested-offspring soft cap - matches the parent app's existing
// NESTED_HOLDING_MAX_TOKENS (lib/leveling.ts) AND
// contracts/src/BreedingController.sol's own NESTED_CAP constant, reused
// rather than reinvented (see design spec: "not a new rule, just not
// exceeding what already makes sense"). If the on-chain constant ever
// changes, this must be updated to match - there is no on-chain read of
// NESTED_CAP() wired up client-side today (it's a `view` getter, so it
// could be read live in a follow-up instead of hardcoded here).
export const MAX_NESTED_OFFSPRING = 5;
