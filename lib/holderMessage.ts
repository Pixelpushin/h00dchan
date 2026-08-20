// Client-safe half of the holder-gate auth (same split as
// lib/adminMessage.ts vs lib/adminAuth.ts) - just the message-building
// logic both the client (asks the wallet to sign this string) and the
// server (lib/holderAuth.ts, reconstructs this exact string independently)
// need to agree on. No `next/server` import, no server-only env reads -
// safe to import from a "use client" component.
//
// ADDRESS_PATTERN itself lives in lib/address.ts (shared with
// lib/adminMessage.ts and every route that validates an address) -
// re-exported here so existing `from "@/lib/holderMessage"` imports keep
// working.
export { ADDRESS_PATTERN } from "@/lib/address";

// Same freshness window as admin sessions - forces a fresh signature
// periodically rather than letting one signed session live forever.
export const HOLDER_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

export function buildHolderAuthMessage(
  address: string,
  issuedAt: string,
): string {
  return `onlyChans holder access\naddress: ${address}\nissued: ${issuedAt}`;
}
