import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { BreedingControllerAbi } from "@/lib/abi/BreedingController";
import {
  parseBredEventFromLogs,
  BRED_EVENT_TOPIC0,
  type RawLog,
} from "./breedingController";

const REAL_CONTROLLER = "0x1111111111111111111111111111111111111111";
const ATTACKER_CONTRACT = "0x2222222222222222222222222222222222222222";

const iface = new Interface(BreedingControllerAbi);

function encodeBredLog(address: string): RawLog {
  const babyTokenId = 42n;
  const fatherTokenId = 531n;
  const motherTokenId = 7n;
  const breedNonce = 3n;
  const seed = 123456789n;
  const genome = [10, 20, 30, 40, 50];
  const motherTba = "0x3333333333333333333333333333333333333333";
  const paymentMethod = 0;
  const amountPaid = 0n;
  const commitId = 1n;

  const fragment = iface.getEvent("Bred");
  if (!fragment) throw new Error("Bred event missing from ABI");

  const encoded = iface.encodeEventLog(fragment, [
    babyTokenId,
    fatherTokenId,
    motherTokenId,
    breedNonce,
    seed,
    genome,
    motherTba,
    paymentMethod,
    amountPaid,
    commitId,
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
    expect(result?.fatherTokenId).toBe("531");
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
