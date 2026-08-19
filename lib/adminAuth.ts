// Server-only half of the wallet-whitelist admin auth (see lib/
// adminMessage.ts for the client-safe message-building half - same split
// as lib/persona.ts vs lib/auth-server.ts). Replaces the single shared-
// secret bearer token every app/api/admin/** route used to check
// independently, reusing this repo's existing personal_sign (EIP-191)
// verification pattern from lib/auth-server.ts exactly: reconstruct the
// message server-side, recover the signing address with ethers'
// verifyMessage, compare it to the claimed address, reject stale
// signatures - the only thing that differs from a persona claim is the
// final check (address-whitelist membership instead of live on-chain
// token ownership), since "is this wallet an admin" isn't something the
// chain can answer.
//
// The bearer-secret path (H00DCHAN_CRON_SECRET) is kept as a second valid
// credential, not removed - some of these routes are also curled directly
// for one-off backfills, and cron-style routes elsewhere in the app
// (app/api/ai/process-scheduled, etc, genuinely triggered by an automated
// schedule with no human present to sign) still need it. requireAdmin
// accepts EITHER: a real security upgrade for the human/interactive path
// without breaking the automation path.
import { verifyMessage } from "ethers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADDRESS_PATTERN,
  ADMIN_SESSION_MAX_AGE_MS,
  buildAdminAuthMessage,
} from "@/lib/adminMessage";

function adminAddresses(): Set<string> {
  const raw = process.env.ADMIN_WALLET_ADDRESSES ?? "";
  return new Set(
    raw
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => ADDRESS_PATTERN.test(a)),
  );
}

export function isAdminAddress(address: string): boolean {
  if (!ADDRESS_PATTERN.test(address)) return false;
  return adminAddresses().has(address.toLowerCase());
}

export interface AdminAuthResult {
  ok: boolean;
  reason?: string;
}

// The actual sign-and-verify check, independent of how the caller
// transported {address, signature, issuedAt} to the server (headers for
// API routes, a plain object for anything else).
export async function verifyAdminSignature(input: {
  address?: string;
  signature?: string;
  issuedAt?: string;
}): Promise<AdminAuthResult> {
  const { address, signature, issuedAt } = input;
  if (!address || !signature || !issuedAt) {
    return { ok: false, reason: "Missing admin auth fields." };
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
  if (Date.now() - issuedAtMs > ADMIN_SESSION_MAX_AGE_MS) {
    return {
      ok: false,
      reason: "Admin session expired, please reconnect and sign again.",
    };
  }

  const expectedMessage = buildAdminAuthMessage(address, issuedAt);
  let recovered: string;
  try {
    recovered = verifyMessage(expectedMessage, signature);
  } catch {
    return { ok: false, reason: "Invalid signature." };
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, reason: "Invalid signature." };
  }

  if (!isAdminAddress(address)) {
    return { ok: false, reason: "This wallet is not an admin." };
  }

  return { ok: true };
}

// Single entry point every app/api/admin/** route should call instead of
// its own local checkAuth(). Accepts either credential:
//   1. Authorization: Bearer <H00DCHAN_CRON_SECRET>  (legacy/automation)
//   2. x-admin-address / x-admin-signature / x-admin-issued-at headers
//      (wallet-signature path - what the /admin/ads UI now sends)
export async function requireAdmin(
  request: NextRequest,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const secret = process.env.H00DCHAN_CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (secret && authHeader === `Bearer ${secret}`) {
    return { ok: true };
  }

  const address = request.headers.get("x-admin-address") ?? undefined;
  const signature = request.headers.get("x-admin-signature") ?? undefined;
  const issuedAt = request.headers.get("x-admin-issued-at") ?? undefined;
  if (address || signature || issuedAt) {
    const result = await verifyAdminSignature({ address, signature, issuedAt });
    if (result.ok) return { ok: true };
    return {
      ok: false,
      response: NextResponse.json(
        { error: result.reason ?? "Unauthorized." },
        { status: 401 },
      ),
    };
  }

  return {
    ok: false,
    response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
  };
}
