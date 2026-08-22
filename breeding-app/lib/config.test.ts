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
