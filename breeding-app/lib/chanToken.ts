// CHAN ERC-20 approve() calldata builder - the first of the two txs in the
// "CHAN approve+breed" flow (a later app task wires the actual page). Raw
// selector, same convention as the rest of this app's reads
// (approve(address,uint256) = 0x095ea7b3, a well-known ERC-20 selector, not
// computed at runtime).
import { CHAN_TOKEN_ADDRESS } from "@/lib/config";
import { encodeUint256, SEL_APPROVE } from "@/lib/chain";

export function buildApproveChanTx(
  spender: string,
  amount: bigint,
): { to: string; data: string } {
  const spenderPadded = spender
    .replace(/^0x/, "")
    .toLowerCase()
    .padStart(64, "0");
  const amountPadded = encodeUint256(amount);
  return {
    to: CHAN_TOKEN_ADDRESS,
    data: `0x${SEL_APPROVE}${spenderPadded}${amountPadded}`,
  };
}
