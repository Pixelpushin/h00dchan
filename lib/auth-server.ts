// Server-only claim verification. Deliberately never imported from a
// client component - `ethers` is only used here, for exactly the one
// raw-crypto operation (`verifyMessage`) the client-side "no viem/wagmi/
// ethers" rule is meant to make an exception for.
//
// Every write to the board (new thread OR reply) must pass this before it
// touches lib/store.ts. Four checks, all required:
//   (a) recover the signing address from signature + message, confirm it
//       equals the claimed address
//   (b) reconstruct the exact message server-side from tokenId+address+
//       issuedAt (never trust a client-supplied message string) - this is
//       what stops a signature for one token being replayed against
//       another: change the tokenId and the reconstructed message changes,
//       so the recovered address no longer matches
//   (c) call readOwnerOf(tokenId) LIVE against the chain right now - the
//       whole point of this system is that a signature can be validly
//       signed and still be worthless if the token sold five minutes later
//   (d) reject if issuedAt is older than 15 minutes, forcing a fresh
//       signature periodically
import { verifyMessage } from "ethers";
import { readOwnerOf } from "@/lib/chain";
import {
  buildAuthMessage,
  PERSONA_MAX_AGE_MS,
  type PersonaClaim,
} from "@/lib/persona";

export interface ClaimVerificationResult {
  ok: boolean;
  reason?: string;
}

export async function verifyPersonaClaim(
  claim: Partial<PersonaClaim>,
): Promise<ClaimVerificationResult> {
  const { tokenId, address, signature, issuedAt } = claim;

  if (!tokenId || !address || !signature || !issuedAt) {
    return { ok: false, reason: "Missing claim fields." };
  }

  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: "Invalid issuedAt timestamp." };
  }
  // Small forward tolerance for clock skew; anything further in the future
  // than that is nonsensical rather than merely stale.
  if (issuedAtMs > Date.now() + 60_000) {
    return { ok: false, reason: "Invalid issuedAt timestamp." };
  }
  if (Date.now() - issuedAtMs > PERSONA_MAX_AGE_MS) {
    return {
      ok: false,
      reason: "Signature expired, please reconnect and sign again.",
    };
  }

  const expectedMessage = buildAuthMessage(tokenId, address, issuedAt);

  let recovered: string;
  try {
    recovered = verifyMessage(expectedMessage, signature);
  } catch {
    return { ok: false, reason: "Invalid signature." };
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, reason: "Invalid signature." };
  }

  let owner: string;
  try {
    owner = await readOwnerOf(tokenId);
  } catch {
    return {
      ok: false,
      reason: "Unable to verify token ownership on-chain right now.",
    };
  }

  if (owner.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, reason: "You no longer hold this token." };
  }

  return { ok: true };
}
