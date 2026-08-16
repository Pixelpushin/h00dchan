// ERC-6551 Token Bound Accounts for HOODCHAN tokens - each NFT gets a
// deterministic on-chain wallet address it can hold assets in, computed via
// the standard registry's account(), no deployment required for that part.
//
// Everything below was verified live against Robinhood Chain mainnet AND
// independently cross-checked against Base mainnet (a chain where
// Tokenbound's real contracts are confirmed live), not assumed from the EIP
// spec or docs:
// - The registry at REGISTRY_ADDRESS has real deployed bytecode and
//   dispatches exactly the two selectors used here (account/createAccount) -
//   confirmed via eth_getCode + a real eth_call, matching the finalized
//   EIP-6551 ABI. Matches Tokenbound's own published deployment address
//   exactly (docs.tokenbound.org/contracts/deployments).
// - IMPLEMENTATION_ADDRESS was WRONG until this fix - the previous constant
//   (0x2d25602551487c3f3354dd80d76d54383a243358) was checked multiple times
//   earlier this session and confirmed to have no code on Robinhood Chain,
//   which was read as "correct address, just not deployed here yet." That
//   was never actually verified against Tokenbound's own docs. It turned
//   out that address has no code on ANY chain, including Base mainnet where
//   Tokenbound's real implementation is definitely live - it was never
//   Tokenbound's real contract at all. The correct address
//   (0x41C8f39463A868d3A88af00cd0fe7102F30E44eC) was confirmed by
//   eth_getCode returning real bytecode on Base mainnet, matching
//   Tokenbound's own deployment docs. Before switching this constant, every
//   TBA address ever computed with the old wrong value was checked for
//   real ETH/NFT/token balances (fetchWalletHoldings) - all zero, so this
//   fix changes nothing anyone has ever actually used.
// - Like the old address, this correct one currently has NO code on
//   Robinhood Chain either (eth_getCode returned "0x") - it has not been
//   deployed here yet. account()'s return value doesn't depend on the
//   implementation actually having code though - it's a pure function of
//   the inputs - so computeTbaAddress() below already returns the real,
//   correct, final TBA address a token will have once that one-time
//   deployment happens.
// - A live eth_call for token #1 returned a real, non-zero, deterministic
//   address, confirming this read path works today.
//
// createAccount() (buildCreateAccountTx) is built and ready, but deploying
// the implementation contract is a separate, explicit decision - not
// bundled into this file. Until that happens, any createAccount() tx built
// here would revert (calling into an implementation with no code). Callers
// must not offer an "activate" action to users until that decision is made.
import { CHAIN_ID_HEX, CONTRACT, rpcCall } from "@/lib/chain";

export const REGISTRY_ADDRESS = "0x000000006551c19487814612e58FE06813775758";
export const IMPLEMENTATION_ADDRESS =
  "0x41C8f39463A868d3A88af00cd0fe7102F30E44eC";

const SELECTOR_ACCOUNT = "246a0021"; // account(address,bytes32,uint256,address,uint256)
const SELECTOR_CREATE_ACCOUNT = "8a54c52f"; // createAccount(address,bytes32,uint256,address,uint256)
const ZERO_SALT = "0".repeat(64); // standard default salt

function encodeUint256(value: number | string | bigint): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeAddress(address: string): string {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function decodeAddress(hex: string): string {
  return `0x${hex.replace(/^0x/, "").slice(-40)}`;
}

function registryCallData(
  selector: string,
  tokenId: number | string | bigint,
): string {
  return (
    `0x${selector}` +
    encodeAddress(IMPLEMENTATION_ADDRESS) +
    ZERO_SALT +
    encodeUint256(CHAIN_ID_HEX) +
    encodeAddress(CONTRACT) +
    encodeUint256(tokenId)
  );
}

// Deterministic TBA address for a token - works today, read-only, no
// deployment needed (see file header).
export async function computeTbaAddress(
  tokenId: number | string | bigint,
): Promise<string> {
  const data = registryCallData(SELECTOR_ACCOUNT, tokenId);
  const result = await rpcCall<string>("eth_call", [
    { to: REGISTRY_ADDRESS, data },
    "latest",
  ]);
  return decodeAddress(result);
}

// True once createAccount() has actually been called for this token (the
// proxy has real bytecode) - false for a "counterfactual" address that's
// been computed but never created. A counterfactual TBA can still receive
// assets; it just has no code to act as a smart account yet.
export async function isTbaActivated(tbaAddress: string): Promise<boolean> {
  const code = await rpcCall<string>("eth_getCode", [tbaAddress, "latest"]);
  return typeof code === "string" && code.length > 2;
}

// {to, data} for the registry's createAccount(...) - the connected wallet
// signs and sends this itself (same lazy, user-signed pattern as the claim
// flow in lib/persona.ts). NOT wired to any UI action yet: calling this
// today would revert, since IMPLEMENTATION_ADDRESS has no deployed code on
// this chain (see file header) - only build a button around this once that
// one-time implementation deployment has been explicitly approved and done.
export function buildCreateAccountTx(tokenId: number | string | bigint): {
  to: string;
  data: string;
} {
  return {
    to: REGISTRY_ADDRESS,
    data: registryCallData(SELECTOR_CREATE_ACCOUNT, tokenId),
  };
}
