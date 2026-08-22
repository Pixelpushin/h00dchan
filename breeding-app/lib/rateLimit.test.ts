import { describe, expect, it, beforeEach, vi } from "vitest";
import type { HeaderSource } from "./rateLimit";

// Both `checkExpensiveScanRateLimit` and `checkBreedPollRateLimit` are
// backed by their own module-level `Map<string, RateEntry>`, so each test
// resets modules and re-imports to start from an empty bucket rather than
// bleeding state across cases (same convention as lib/config.test.ts).
describe("rateLimit - dedicated buckets deplete independently (ITEM 9)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function headersFor(ip: string): HeaderSource {
    return {
      get(name: string) {
        if (name === "x-forwarded-for") return ip;
        return null;
      },
    };
  }

  it("checkExpensiveScanRateLimit and checkBreedPollRateLimit track separate counters for the same IP", async () => {
    const { checkExpensiveScanRateLimit, checkBreedPollRateLimit } =
      await import("./rateLimit");
    const headers = headersFor("1.2.3.4");

    // Exhaust the expensive-scan bucket (max 60) for this IP.
    for (let i = 0; i < 60; i++) {
      const result = checkExpensiveScanRateLimit(headers);
      expect(result.allowed).toBe(true);
    }
    const scanDenied = checkExpensiveScanRateLimit(headers);
    expect(scanDenied.allowed).toBe(false);

    // The breed-poll bucket for the SAME IP must be untouched - this is the
    // exact bug ITEM 9 fixes: before the dedicated bucket, one breed's poll
    // loop (up to 60 requests) would have already exhausted the shared
    // limit here too.
    const pollResult = checkBreedPollRateLimit(headers);
    expect(pollResult.allowed).toBe(true);
  });

  it("exhausting checkBreedPollRateLimit does not affect checkExpensiveScanRateLimit for the same IP", async () => {
    const { checkExpensiveScanRateLimit, checkBreedPollRateLimit } =
      await import("./rateLimit");
    const headers = headersFor("5.6.7.8");

    // Simulate two concurrent full poll runs (60 requests each, per
    // pollForResult's own attempt cap) plus one more to prove the bucket's
    // headroom is intentionally above a single run's size.
    for (let i = 0; i < 120; i++) {
      const result = checkBreedPollRateLimit(headers);
      expect(result.allowed).toBe(true);
    }

    // The expensive-scan bucket for the SAME IP must still be fully fresh.
    const scanResult = checkExpensiveScanRateLimit(headers);
    expect(scanResult.allowed).toBe(true);
  });

  it("checkBreedPollRateLimit itself still enforces a real cap, just a separate/larger one", async () => {
    const { checkBreedPollRateLimit } = await import("./rateLimit");
    const headers = headersFor("9.9.9.9");

    let lastResult = {
      allowed: true,
      retryAfterSeconds: 0,
      scope: "ip" as const,
    };
    for (let i = 0; i < 200; i++) {
      lastResult = checkBreedPollRateLimit(headers);
    }
    expect(lastResult.allowed).toBe(false);
    expect(lastResult.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("different IPs never share either bucket's count", async () => {
    const { checkBreedPollRateLimit } = await import("./rateLimit");
    const headersA = headersFor("10.0.0.1");
    const headersB = headersFor("10.0.0.2");

    for (let i = 0; i < 150; i++) {
      checkBreedPollRateLimit(headersA);
    }
    const deniedA = checkBreedPollRateLimit(headersA);
    expect(deniedA.allowed).toBe(false);

    const allowedB = checkBreedPollRateLimit(headersB);
    expect(allowedB.allowed).toBe(true);
  });
});
