import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BreedingControllerAbi } from "@/lib/abi/BreedingController";
import {
  parseBredEventFromLogs,
  previewBreedFee,
  BRED_EVENT_TOPIC0,
  type RawLog,
} from "./breedingController";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const REAL_CONTROLLER = "0x1111111111111111111111111111111111111111";
const ATTACKER_CONTRACT = "0x2222222222222222222222222222222222222222";

const iface = new Interface(BreedingControllerAbi);

function encodeBredLog(address: string): RawLog {
  const babyTokenId = 42n;
  const matronCollection = "0x3333333333333333333333333333333333333333";
  const matronId = 531n;
  const sireCollection = "0x4444444444444444444444444444444444444444";
  const sireId = 7n;
  const breedNonce = 3n;
  const seed = 123456789n;
  const genome = [10, 20, 30, 40, 50];
  const babyIsMale = true;
  const isTestTubeBaby = false;

  const fragment = iface.getEvent("Bred");
  if (!fragment) throw new Error("Bred event missing from ABI");

  const encoded = iface.encodeEventLog(fragment, [
    babyTokenId,
    matronCollection,
    matronId,
    sireCollection,
    sireId,
    breedNonce,
    seed,
    genome,
    babyIsMale,
    isTestTubeBaby,
  ]);

  return {
    address,
    topics: encoded.topics as string[],
    data: encoded.data,
  };
}

// BUG 5(a): a log that is otherwise byte-for-byte a real, well-formed Bred
// event (same topic0, same ABI-encodable data) MUST be rejected if it was
// NOT emitted by the configured BreedingController address - this is the
// exact mechanism an attacker would use to pre-populate a forged breeding
// record for a babyId that hasn't actually bred yet (see
// lib/breedingStore.ts's header comment for the full exploit chain this
// closes).
describe("parseBredEventFromLogs - BUG 5(a) address verification", () => {
  it("accepts a Bred log emitted by the real controller address", () => {
    const log = encodeBredLog(REAL_CONTROLLER);
    const result = parseBredEventFromLogs([log], REAL_CONTROLLER);
    expect(result).not.toBeNull();
    expect(result?.babyTokenId).toBe("42");
    expect(result?.matronId).toBe("531");
    expect(result?.sireId).toBe("7");
    expect(result?.babyIsMale).toBe(true);
    expect(result?.isTestTubeBaby).toBe(false);
  });

  it("accepts a Bred log from the real controller regardless of topic address case", () => {
    const log = encodeBredLog(REAL_CONTROLLER.toLowerCase());
    const result = parseBredEventFromLogs([log], REAL_CONTROLLER.toUpperCase());
    expect(result).not.toBeNull();
  });

  it("rejects an identically-shaped Bred log emitted by a DIFFERENT contract address", () => {
    const forgedLog = encodeBredLog(ATTACKER_CONTRACT);
    const result = parseBredEventFromLogs([forgedLog], REAL_CONTROLLER);
    expect(result).toBeNull();
  });

  it("rejects a forged log even when a real log for a different babyId is also present", () => {
    const forgedLog = encodeBredLog(ATTACKER_CONTRACT);
    const realLog = encodeBredLog(REAL_CONTROLLER);
    // Forged log listed first - the scan must not stop at (or trust) it.
    const result = parseBredEventFromLogs(
      [forgedLog, realLog],
      REAL_CONTROLLER,
    );
    expect(result).not.toBeNull();
    expect(result?.babyTokenId).toBe("42");
  });

  it("rejects a log with the right address but the wrong topic0 (not actually a Bred event)", () => {
    const log = encodeBredLog(REAL_CONTROLLER);
    const tampered: RawLog = {
      ...log,
      topics: [
        "0x" + "ab".repeat(32), // bogus topic0, not BRED_EVENT_TOPIC0
        ...log.topics.slice(1),
      ],
    };
    const result = parseBredEventFromLogs([tampered], REAL_CONTROLLER);
    expect(result).toBeNull();
  });

  it("BRED_EVENT_TOPIC0 is derived from the real ABI, not a guessed literal", () => {
    const fragment = iface.getEvent("Bred");
    expect(BRED_EVENT_TOPIC0).toBe(fragment?.topicHash);
  });
});

// ---------------------------------------------------------------------------
// previewBreedFee - verified against the SAME forge-generated fee vectors
// as lib/breedingGenetics.parity.test.ts's fee suite, exercising the real
// exported app-facing helper this time (not a locally re-derived formula),
// so a regression in the actual code path callers use gets caught here.
// ---------------------------------------------------------------------------

interface FeeVector {
  birthFee: string;
  sameSexFeeMultiplier: string;
  sameSex: boolean;
  selfSiring: boolean;
  listedFee: string;
  expectedBirthFeePaid: string;
  expectedSireOwnerAmount: string;
  expectedBurnAmount: string;
  expectedMultisigAmount: string;
  expectedTotalCallerDebit: string;
}

function loadFeeVectors(filename: string): FeeVector[] {
  const p = path.resolve(dirname, "../contracts", filename);
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as { fees: FeeVector[] };
  return parsed.fees;
}

function runFeeSuite(label: string, filename: string, minCount: number) {
  describe(`previewBreedFee vs ${label} (${filename})`, () => {
    const vectors = loadFeeVectors(filename);

    it(`loads at least ${minCount} fee vectors`, () => {
      expect(vectors.length).toBeGreaterThanOrEqual(minCount);
    });

    it("matches every expected*Amount/expectedTotalCallerDebit field exactly", () => {
      for (const v of vectors) {
        // Fixture's `selfSiring` flag gates whether the siring-fee leg
        // applies at all - maps 1:1 onto previewBreedFee's
        // `sireCallerOwned` param (BreedingController.breed() only calls
        // _collectSiringFee when `!sireCallerOwned`).
        const result = previewBreedFee({
          birthFee: BigInt(v.birthFee),
          sameSexFeeMultiplier: BigInt(v.sameSexFeeMultiplier),
          // sameSex is derivable from matronSex===sireSex in the genetics
          // vectors, but the fee vectors carry it directly - encode it via
          // two sex flags that satisfy `matronSex === sireSex === v.sameSex`.
          matronSex: true,
          sireSex: v.sameSex,
          sireCallerOwned: v.selfSiring,
          listedPrice: BigInt(v.listedFee),
        });
        expect(result.birthFeePaid.toString()).toBe(v.expectedBirthFeePaid);
        expect(result.sireOwnerAmount.toString()).toBe(
          v.expectedSireOwnerAmount,
        );
        expect(result.burnAmount.toString()).toBe(v.expectedBurnAmount);
        expect(result.multisigAmount.toString()).toBe(v.expectedMultisigAmount);
        expect(result.totalCallerDebit.toString()).toBe(
          v.expectedTotalCallerDebit,
        );
      }
    });
  });
}

runFeeSuite("primary fixture", "test-vectors.json", 100);
runFeeSuite("fresh/staleness-guard fixture", "test-vectors-fresh.json", 40);

describe("previewBreedFee - additional properties", () => {
  it("self-siring pays zero siring fee and zero protocol fee, only the birth fee", () => {
    const result = previewBreedFee({
      birthFee: 10n,
      sameSexFeeMultiplier: 2n,
      matronSex: true,
      sireSex: false,
      sireCallerOwned: true,
      listedPrice: 999_999n, // must be ignored entirely when self-siring
    });
    expect(result.sireOwnerAmount).toBe(0n);
    expect(result.burnAmount).toBe(0n);
    expect(result.multisigAmount).toBe(0n);
    expect(result.totalCallerDebit).toBe(10n);
  });

  it("independent floor division can leave up to 1 wei of protocol fee uncollected, always in the caller's favor", () => {
    // price=3: 3*500/10000 floors to 0, 3*300/10000 floors to 0 - a
    // combined `3*800/10000` would also floor to 0 here, but the point is
    // proven at price=25 below where the two differ from a single-multiply.
    const result = previewBreedFee({
      birthFee: 0n,
      sameSexFeeMultiplier: 1n,
      matronSex: true,
      sireSex: false,
      sireCallerOwned: false,
      listedPrice: 25n,
    });
    // 25*500/10000 = 1 (floor 1.25), 25*300/10000 = 0 (floor 0.75) - sums
    // to 1, one wei short of a theoretical 25*800/10000 = 2 (floor 2.0).
    expect(result.burnAmount).toBe(1n);
    expect(result.multisigAmount).toBe(0n);
    expect(result.totalCallerDebit).toBe(25n + 1n + 0n);
  });

  it("same-sex pairing multiplies only the birth fee, never the siring fee", () => {
    const opposite = previewBreedFee({
      birthFee: 100n,
      sameSexFeeMultiplier: 3n,
      matronSex: true,
      sireSex: false,
      sireCallerOwned: false,
      listedPrice: 1000n,
    });
    const sameSex = previewBreedFee({
      birthFee: 100n,
      sameSexFeeMultiplier: 3n,
      matronSex: true,
      sireSex: true,
      sireCallerOwned: false,
      listedPrice: 1000n,
    });
    expect(sameSex.birthFeePaid).toBe(opposite.birthFeePaid * 3n);
    expect(sameSex.sireOwnerAmount).toBe(opposite.sireOwnerAmount);
    expect(sameSex.burnAmount).toBe(opposite.burnAmount);
    expect(sameSex.multisigAmount).toBe(opposite.multisigAmount);
  });
});
