// Shared claim/persona types + the exact message-building logic used by
// both the client (asks the wallet to sign this string) and the server
// (reconstructs this exact string independently before checking a
// signature against it). Keeping it in one place means the two can never
// drift apart - a mismatch here would either break every legitimate post
// or, worse, open a hole where a client-supplied message string gets
// trusted instead of a server-reconstructed one.

export interface PersonaClaim {
  tokenId: string;
  address: string;
  signature: string;
  issuedAt: string; // ISO timestamp, when the signature was produced
}

// sessionStorage (not localStorage): this is a per-tab, per-session
// "posting as" identity, not something that should silently persist
// across browser restarts.
export const PERSONA_SESSION_KEY = "h00dchan:persona";

// Forces a fresh signature periodically - limits how long a leaked/stale
// signature stays useful, and (paired with the live ownerOf check on every
// write) keeps the "you no longer hold this token" check meaningfully
// fresh rather than checked once at signing time.
export const PERSONA_MAX_AGE_MS = 15 * 60 * 1000;

export function buildAuthMessage(
  tokenId: string,
  address: string,
  issuedAt: string,
): string {
  return `h00dchan posting authorization\ntoken: HOODCHAN #${tokenId}\naddress: ${address}\nissued: ${issuedAt}`;
}

// Canonical token ID form only: plain decimal digits, no leading zero, no
// 0x/0b/0o prefix, no whitespace, in [1, 1200]. Without this gate,
// BigInt("1"), BigInt("01"), BigInt("0x1"), and BigInt("+1") all resolve to
// the same on-chain token but were previously accepted as distinct strings
// - stored, rate-limited, and displayed as different identities ("Anon #1"
// vs "Anon #01" vs "Anon #0x1") for what is actually one NFT. That doesn't
// let anyone post as a token they don't own, but it does let one token
// sockpuppet as multiple "different" anons, which defeats the point of the
// token gate. Reject anything non-canonical before it ever reaches an RPC
// call, a rate-limit key, or storage.
const TOKEN_ID_PATTERN = /^[1-9][0-9]{0,3}$/;
const MAX_TOKEN_ID = 1200;

export function isValidTokenId(tokenId: string): boolean {
  return TOKEN_ID_PATTERN.test(tokenId) && Number(tokenId) <= MAX_TOKEN_ID;
}
