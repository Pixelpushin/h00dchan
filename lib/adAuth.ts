// Server-only half of the ad-submission auth (see lib/adMessage.ts for the
// client-safe message-building half). Same personal_sign (EIP-191)
// verification pattern as lib/holderAuth.ts/lib/adminAuth.ts - reconstruct
// the message server-side, recover the signer, compare to the claimed
// submitterAddress, reject stale signatures. No live chain read needed
// here (unlike holderAuth's balance check) - this only proves "this HTTP
// request came from whoever controls submitterAddress," the actual payment
// itself is separately verified on-chain by lib/adPayment.ts.
import { verifyMessage } from "ethers";
import {
  ADDRESS_PATTERN,
  AD_SUBMISSION_MAX_AGE_MS,
  buildAdSubmissionAuthMessage,
} from "@/lib/adMessage";

export interface AdSubmissionAuthResult {
  ok: boolean;
  reason?: string;
}

export function verifyAdSubmissionSignature(input: {
  txHash: string;
  submitterAddress: string;
  signature?: string;
  issuedAt?: string;
}): AdSubmissionAuthResult {
  const { txHash, submitterAddress, signature, issuedAt } = input;
  if (!signature || !issuedAt) {
    return { ok: false, reason: "Missing ad submission signature." };
  }
  if (!ADDRESS_PATTERN.test(submitterAddress)) {
    return { ok: false, reason: "Invalid submitter address." };
  }

  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: "Invalid issuedAt timestamp." };
  }
  if (issuedAtMs > Date.now() + 60_000) {
    return { ok: false, reason: "Invalid issuedAt timestamp." };
  }
  if (Date.now() - issuedAtMs > AD_SUBMISSION_MAX_AGE_MS) {
    return {
      ok: false,
      reason: "Submission signature expired - please try again.",
    };
  }

  const expectedMessage = buildAdSubmissionAuthMessage(
    txHash,
    submitterAddress,
    issuedAt,
  );
  let recovered: string;
  try {
    recovered = verifyMessage(expectedMessage, signature);
  } catch {
    return { ok: false, reason: "Invalid signature." };
  }
  if (recovered.toLowerCase() !== submitterAddress.toLowerCase()) {
    return { ok: false, reason: "Invalid signature." };
  }

  return { ok: true };
}
