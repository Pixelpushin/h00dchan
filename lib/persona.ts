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
  // Present only when this persona came from "Activate All" (a batch
  // signature over buildBatchAuthMessage's string) rather than a
  // single-token signature over buildAuthMessage's string - the server
  // needs to know which message to reconstruct before checking `signature`
  // (see lib/auth-server.ts's verifyPersonaClaim). tokenId is always the
  // one specific token currently being posted as; batchTokenIds is the
  // full set the signature actually covers.
  batchTokenIds?: string[];
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

// One signature authorizing a whole batch of tokens at once ("Activate
// All" - see app/components/HomeClient.tsx) instead of one wallet prompt
// per token. Claiming was never an on-chain transaction to begin with (no
// gas, per the site's own copy) - it's a personal_sign proving "I hold
// these addresses' tokens right now," so batching it is just building one
// message instead of N, not a smart-contract multicall. Token IDs are
// sorted numerically before building the message so the client and server
// always agree on the exact string regardless of array order the caller
// happened to pass.
export function buildBatchAuthMessage(
  tokenIds: string[],
  address: string,
  issuedAt: string,
): string {
  const sorted = [...tokenIds].sort((a, b) => Number(a) - Number(b));
  const list = sorted.map((id) => `HOODCHAN #${id}`).join(", ");
  return `h00dchan posting authorization (batch)\ntokens: ${list}\naddress: ${address}\nissued: ${issuedAt}`;
}

// One live eth_call per token in the batch (see verifyBatchPersonaClaim) -
// bounded so a single request can't force an unbounded number of RPC
// calls. Comfortably above what any real holder needs (1198 total supply,
// and holding even a small fraction of a collection this size is already
// a lot).
export const MAX_BATCH_CLAIM_SIZE = 50;

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
