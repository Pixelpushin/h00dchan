// Thin adapter over @pixelpushin/tba-kit (github:Pixelpushin/tba-kit) - the
// shared ERC-6551 Token Bound Account implementation used across every
// Pixelpushin project on Robinhood Chain (h00dchan, hoodies-fight, and
// beyond), so every project computes the exact same wallet address for the
// exact same (implementation, chainId, tokenContract, tokenId) input. The
// real logic, the REGISTRY_ADDRESS/IMPLEMENTATION_ADDRESS constants, and
// the full verification history (an earlier wrong implementation address
// caught and fixed this same session) all live in that package now - see
// its README/src for the details. This file just binds HOODCHAN's own
// contract address so the rest of this app can keep calling
// `computeTbaAddress(tokenId)` with the same single-argument shape it
// already used.
import { CONTRACT, CHAIN_ID_HEX } from "@/lib/chain";
import * as tbaKit from "@pixelpushin/tba-kit";

export const REGISTRY_ADDRESS = tbaKit.REGISTRY_ADDRESS;
export const IMPLEMENTATION_ADDRESS = tbaKit.IMPLEMENTATION_ADDRESS;

export async function computeTbaAddress(
  tokenId: number | string | bigint,
): Promise<string> {
  return tbaKit.computeTbaAddress({
    tokenContract: CONTRACT,
    tokenId,
    chainIdHex: CHAIN_ID_HEX,
  });
}

export async function isTbaActivated(tbaAddress: string): Promise<boolean> {
  return tbaKit.isTbaActivated(tbaAddress);
}

// {to, data} for the registry's createAccount(...) - the connected wallet
// signs and sends this itself. NOT wired to any UI action yet: calling
// this today would revert, since IMPLEMENTATION_ADDRESS has no deployed
// code on this chain yet - only build a button around this once that
// one-time implementation deployment has been explicitly approved and
// done.
export function buildCreateAccountTx(tokenId: number | string | bigint): {
  to: string;
  data: string;
} {
  return tbaKit.buildCreateAccountTx({
    tokenContract: CONTRACT,
    tokenId,
    chainIdHex: CHAIN_ID_HEX,
  });
}
