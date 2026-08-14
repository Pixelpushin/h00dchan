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
