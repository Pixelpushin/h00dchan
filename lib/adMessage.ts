// Client-safe half of the ad-submission auth (same split as
// lib/holderMessage.ts vs lib/holderAuth.ts) - just the message-building
// logic both the client (asks the wallet to sign this string right after
// sending the payment) and the server (lib/adAuth.ts, reconstructs this
// exact string independently) need to agree on.
//
// Binding txHash + submitterAddress into the signed message is the actual
// fix for a real bug: verifyAdPayment (lib/adPayment.ts) checks that the
// on-chain tx's sender matches `submitterAddress`, but `submitterAddress`
// itself was just an unauthenticated client-supplied string - since
// treasury payments are public on-chain, anyone who spots a real
// advertiser's payment could submit first with the victim's own address
// (passing the tx.from check) and their own ad content, stealing the slot.
// A signature over this exact message proves the HTTP request itself came
// from someone who controls `submitterAddress`'s private key, which an
// on-chain observer never has - reusing a different wallet's signature for
// a different tx/address is cryptographically impossible, not just
// "against the rules."
export { ADDRESS_PATTERN } from "@/lib/address";

export const AD_SUBMISSION_MAX_AGE_MS = 15 * 60 * 1000;

export function buildAdSubmissionAuthMessage(
  txHash: string,
  submitterAddress: string,
  issuedAt: string,
): string {
  return `h00dchan ad submission\ntx: ${txHash}\naddress: ${submitterAddress}\nissued: ${issuedAt}`;
}
