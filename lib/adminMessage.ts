// Client-safe half of the admin auth split (mirrors lib/persona.ts vs
// lib/auth-server.ts's existing separation) - just the message-building
// logic both the client (asks the wallet to sign this string) and the
// server (lib/adminAuth.ts, reconstructs this exact string independently)
// need to agree on. No `next/server` import and no reads of the
// server-only ADMIN_WALLET_ADDRESSES env var here, so this is safe to
// import from a "use client" component without pulling server-only code
// into the browser bundle.
export const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

// Same freshness window as persona claims (lib/persona.ts's
// PERSONA_MAX_AGE_MS) - forces a fresh signature periodically rather than
// letting one signed session live forever.
export const ADMIN_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

export function buildAdminAuthMessage(
  address: string,
  issuedAt: string,
): string {
  return `h00dchan admin authorization\naddress: ${address}\nissued: ${issuedAt}`;
}
