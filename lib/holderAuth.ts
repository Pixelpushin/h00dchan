// Server-only half of the onlyChans holder gate (see lib/holderMessage.ts
// for the client-safe message-building half). Same personal_sign (EIP-191)
// verification pattern as lib/adminAuth.ts - the only thing that differs
// is the final check: instead of an address whitelist, this does a LIVE
// on-chain balance check (holds >=1 HOODCHAN NFT OR any amount of CHAN)
// so access tracks actual current holding, not a point-in-time list.
//
// Uses the Alchemy-backed RPC + retry, not lib/chain.ts's raw RPC_URL
// default - the public Robinhood Chain RPC is documented elsewhere in this
// codebase as flaky under load (lib/leaderboard.ts hit this for real: a
// real holder's token silently dropped out of results with zero retry).
// A flaky read here would incorrectly lock out a real holder, not just
// misdraw a leaderboard row, so it gets the same reliability treatment.
import { verifyMessage } from "ethers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { CONTRACT, readBalanceOf, RPC_URL } from "@/lib/chain";
import {
  ADDRESS_PATTERN,
  buildHolderAuthMessage,
  HOLDER_SESSION_MAX_AGE_MS,
} from "@/lib/holderMessage";

const CHAN_TOKEN_ADDRESS = "0xb36fd5d3392c78e70c3e08f46b46f242e7ef654f";

const ALCHEMY_RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : RPC_URL;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

export async function isHolderAddress(address: string): Promise<boolean> {
  if (!ADDRESS_PATTERN.test(address)) return false;

  const [nftBalance, chanBalance] = await Promise.all([
    withRetry(() => readBalanceOf(CONTRACT, address, ALCHEMY_RPC_URL)),
    withRetry(() =>
      readBalanceOf(CHAN_TOKEN_ADDRESS, address, ALCHEMY_RPC_URL),
    ),
  ]);
  return nftBalance > BigInt(0) || chanBalance > BigInt(0);
}

export interface HolderAuthResult {
  ok: boolean;
  reason?: string;
}

export async function verifyHolderSignature(input: {
  address?: string;
  signature?: string;
  issuedAt?: string;
}): Promise<HolderAuthResult> {
  const { address, signature, issuedAt } = input;
  if (!address || !signature || !issuedAt) {
    return { ok: false, reason: "Missing holder auth fields." };
  }
  if (!ADDRESS_PATTERN.test(address)) {
    return { ok: false, reason: "Invalid address." };
  }

  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: "Invalid issuedAt timestamp." };
  }
  if (issuedAtMs > Date.now() + 60_000) {
    return { ok: false, reason: "Invalid issuedAt timestamp." };
  }
  if (Date.now() - issuedAtMs > HOLDER_SESSION_MAX_AGE_MS) {
    return {
      ok: false,
      reason: "Session expired, please reconnect and sign again.",
    };
  }

  const expectedMessage = buildHolderAuthMessage(address, issuedAt);
  let recovered: string;
  try {
    recovered = verifyMessage(expectedMessage, signature);
  } catch {
    return { ok: false, reason: "Invalid signature." };
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, reason: "Invalid signature." };
  }

  let holds: boolean;
  try {
    holds = await isHolderAddress(address);
  } catch {
    return {
      ok: false,
      reason: "Unable to verify holdings right now - try again shortly.",
    };
  }
  if (!holds) {
    return {
      ok: false,
      reason: "This wallet doesn't hold HOODCHAN or CHAN.",
    };
  }

  return { ok: true };
}

// Entry point for app/api/onlychans/** routes - reads the same header
// shape as lib/adminAuth.ts's requireAdmin (x-holder-address/-signature/
// -issued-at), just checked against live holdings instead of a whitelist.
export async function requireHolder(
  request: NextRequest,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const address = request.headers.get("x-holder-address") ?? undefined;
  const signature = request.headers.get("x-holder-signature") ?? undefined;
  const issuedAt = request.headers.get("x-holder-issued-at") ?? undefined;

  const result = await verifyHolderSignature({ address, signature, issuedAt });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    response: NextResponse.json(
      { error: result.reason ?? "Unauthorized." },
      { status: 401 },
    ),
  };
}
