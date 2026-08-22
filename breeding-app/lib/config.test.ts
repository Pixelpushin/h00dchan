import { describe, expect, it, beforeEach, vi } from "vitest";

// getContractStatus() reads process.env at module-eval time, so each case
// resets modules and re-imports to pick up a fresh env snapshot rather than
// relying on the already-evaluated top-level exports.
describe("getContractStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_GIRLFRIENDS_CONTRACT;
    delete process.env.NEXT_PUBLIC_BABIES_CONTRACT;
    delete process.env.NEXT_PUBLIC_BREEDING_CONTROLLER_CONTRACT;
  });

  it("reports nothing deployed when the breeding-specific addresses are unset", async () => {
    const { getContractStatus } = await import("./config");
    expect(getContractStatus()).toEqual({
      girlfriends: false,
      babies: false,
      breedingController: false,
      allDeployed: false,
    });
  });

  it("reports allDeployed once all three breeding-specific addresses are set", async () => {
    process.env.NEXT_PUBLIC_GIRLFRIENDS_CONTRACT =
      "0x1111111111111111111111111111111111111111";
    process.env.NEXT_PUBLIC_BABIES_CONTRACT =
      "0x2222222222222222222222222222222222222222";
    process.env.NEXT_PUBLIC_BREEDING_CONTROLLER_CONTRACT =
      "0x3333333333333333333333333333333333333333";
    const { getContractStatus } = await import("./config");
    expect(getContractStatus()).toEqual({
      girlfriends: true,
      babies: true,
      breedingController: true,
      allDeployed: true,
    });
  });

  it("defaults HOODCHAN_CONTRACT and CHAN_TOKEN_ADDRESS even with no env set", async () => {
    const { HOODCHAN_CONTRACT, CHAN_TOKEN_ADDRESS } = await import("./config");
    expect(HOODCHAN_CONTRACT).toBe(
      "0x774Db2207D26570F5638028839c816702A40aBC2",
    );
    expect(CHAN_TOKEN_ADDRESS).toBe(
      "0xB36fD5d3392C78E70c3E08f46b46F242e7EF654F",
    );
  });
});

// v2 design spec's fee/cooldown mirrors - see lib/config.ts's own header
// comments on each constant for which of these are true contract constants
// (can't drift) vs. owner-configurable defaults (pre-deploy-preview only).
describe("v2 fee + cooldown config mirrors", () => {
  it("mirrors Deploy.s.sol's DEFAULT_BIRTH_FEE / DEFAULT_SAME_SEX_FEE_MULTIPLIER", async () => {
    const { DEFAULT_BIRTH_FEE, DEFAULT_SAME_SEX_FEE_MULTIPLIER } =
      await import("./config");
    expect(DEFAULT_BIRTH_FEE).toBe(100_000_000_000_000_000_000n);
    expect(DEFAULT_SAME_SEX_FEE_MULTIPLIER).toBe(2n);
  });

  it("mirrors BreedingController._collectSiringFee's 5%/3%/8% bps split exactly", async () => {
    const {
      SIRING_BURN_FEE_BPS,
      SIRING_MULTISIG_FEE_BPS,
      SIRING_PROTOCOL_FEE_BPS,
      FEE_BPS_DENOMINATOR,
    } = await import("./config");
    expect(SIRING_BURN_FEE_BPS).toBe(500n);
    expect(SIRING_MULTISIG_FEE_BPS).toBe(300n);
    expect(SIRING_PROTOCOL_FEE_BPS).toBe(800n);
    expect(FEE_BPS_DENOMINATOR).toBe(10000n);
  });

  it("mirrors BreedingController._cooldownSeconds's 14-entry ladder exactly, capped at 7 days", async () => {
    const { COOLDOWN_SECONDS_LADDER, cooldownSecondsForBreedCount } =
      await import("./config");
    expect(COOLDOWN_SECONDS_LADDER).toEqual([
      60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 57600, 86400, 172800,
      345600, 604800,
    ]);
    expect(cooldownSecondsForBreedCount(0)).toBe(60);
    expect(cooldownSecondsForBreedCount(13)).toBe(604800);
    // Past the ladder's length, clamp forever at the last (7-day) entry -
    // matches the contract's own clamp, not an out-of-bounds read.
    expect(cooldownSecondsForBreedCount(14)).toBe(604800);
    expect(cooldownSecondsForBreedCount(1000)).toBe(604800);
  });

  it("BURN_ADDRESS / MULTISIG_ADDRESS are undefined env-driven placeholders when unset, per the design spec's Open Questions", async () => {
    delete process.env.NEXT_PUBLIC_BURN_ADDRESS;
    delete process.env.NEXT_PUBLIC_MULTISIG_ADDRESS;
    const { BURN_ADDRESS, MULTISIG_ADDRESS } = await import("./config");
    expect(BURN_ADDRESS).toBeUndefined();
    expect(MULTISIG_ADDRESS).toBeUndefined();
  });
});

describe("MAX_NESTED_OFFSPRING is fully removed (nested-cap mechanic is dead, see design spec)", () => {
  it("config.ts has no MAX_NESTED_OFFSPRING export", async () => {
    const config = await import("./config");
    expect("MAX_NESTED_OFFSPRING" in config).toBe(false);
  });
});
