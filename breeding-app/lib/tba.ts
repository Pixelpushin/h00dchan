// Adapted from the parent h00dchan repo's lib/tba.ts (copied, not
// imported - separate Vercel project, can't see outside breeding-app/).
// Thin adapter over @pixelpushin/tba-kit (github:Pixelpushin/tba-kit) - the
// shared ERC-6551 Token Bound Account implementation used across every
// Pixelpushin project on Robinhood Chain, so every project computes the
// exact same wallet address for the exact same (implementation, chainId,
// tokenContract, tokenId) input. The real logic, the
// REGISTRY_ADDRESS/IMPLEMENTATION_ADDRESS constants, and the full
// verification history all live in that package - see its README/src.
//
// Unlike the source file, every exported function here takes a
// `tokenContract` as an explicit parameter instead of closing over a
// single hardcoded CONTRACT constant - this app deals with three separate
// collections (HOODCHAN father, Girlfriends mother, Babies offspring; see
// lib/config.ts), not one, so there is no single "the" contract to bind
// ahead of time the way the source file could.
import * as tbaKit from "@pixelpushin/tba-kit";
import { Interface } from "ethers";
import { CHAIN_ID_HEX, DEFAULT_RPC_URL } from "@/lib/config";

// execute()/transfer() encoding - local to this app, not in
// @pixelpushin/tba-kit (that package's README explicitly says
// spend/execute isn't in there yet). Every Tokenbound V3 account exposes
// execute(address,uint256,bytes,uint8) - confirmed live against the
// deployed implementation on Robinhood Chain by the source file (selector
// 0x51945447 present in the contract's own eth_getCode dump, not just
// assumed from the ABI).
const ACCOUNT_ABI = [
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
];
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];
// safeTransferFrom, not transferFrom - the TBA is a contract calling this
// on its own behalf (from === the TBA itself), and safeTransferFrom's
// receiver-hook check protects against sending an NFT into a contract
// address that can't actually hold it, same safety property transferFrom
// doesn't give you. Explicit 3-arg signature only (no bytes data param) -
// ERC-721 overloads safeTransferFrom, and ethers needs the exact selector
// disambiguated rather than left to guess which one.
const ERC721_ABI = [
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
];
const accountInterface = new Interface(ACCOUNT_ABI);
const erc20Interface = new Interface(ERC20_ABI);
const erc721Interface = new Interface(ERC721_ABI);

// operation 0 = plain CALL (the only one Tokenbound's guardian allows a
// regular EOA owner to use - 1/2/3 are DELEGATECALL/CREATE/CREATE2, gated
// behind stricter permissions this app has no need for).
const OPERATION_CALL = 0;

export const REGISTRY_ADDRESS = tbaKit.REGISTRY_ADDRESS;
export const IMPLEMENTATION_ADDRESS = tbaKit.IMPLEMENTATION_ADDRESS;

export async function computeTbaAddress(
  tokenContract: string,
  tokenId: number | string | bigint,
): Promise<string> {
  return tbaKit.computeTbaAddress({
    tokenContract,
    tokenId,
    chainIdHex: CHAIN_ID_HEX,
    rpcUrl: DEFAULT_RPC_URL,
  });
}

export async function isTbaActivated(tbaAddress: string): Promise<boolean> {
  return tbaKit.isTbaActivated(tbaAddress, DEFAULT_RPC_URL);
}

// {to, data} for the registry's createAccount(...) - the connected wallet
// signs and sends this itself.
export function buildCreateAccountTx(
  tokenContract: string,
  tokenId: number | string | bigint,
): {
  to: string;
  data: string;
} {
  return tbaKit.buildCreateAccountTx({
    tokenContract,
    tokenId,
    chainIdHex: CHAIN_ID_HEX,
  });
}

// {to, data} to send native ETH out of an activated TBA - the connected
// wallet (which must be the account's authorized owner/signer) calls
// execute() ON the TBA itself, which then forwards `valueWei` of its own
// held ETH to `to`. The outer transaction's own value stays 0 - no ETH
// leaves the caller's wallet, only the TBA's.
export function buildSendEthTx(
  tbaAddress: string,
  to: string,
  valueWei: bigint,
): { to: string; data: string } {
  return {
    to: tbaAddress,
    data: accountInterface.encodeFunctionData("execute", [
      to,
      valueWei,
      "0x",
      OPERATION_CALL,
    ]),
  };
}

// Same idea, but for an ERC-20 balance the TBA holds (e.g. paying a siring
// fee in CHAN out of a TBA rather than the caller's own EOA): execute()
// tells the TBA to call transfer() on the token contract itself, moving
// tokens out of the TBA's own balance.
export function buildSendTokenTx(
  tbaAddress: string,
  tokenContract: string,
  to: string,
  amountRaw: bigint,
): { to: string; data: string } {
  const transferData = erc20Interface.encodeFunctionData("transfer", [
    to,
    amountRaw,
  ]);
  return {
    to: tbaAddress,
    data: accountInterface.encodeFunctionData("execute", [
      tokenContract,
      BigInt(0),
      transferData,
      OPERATION_CALL,
    ]),
  };
}

// Same idea, but for an NFT (ERC-721) the TBA holds - including a baby
// minted into a mother's TBA (see the design spec's breeding flow: babies
// mint directly into the mother's TBA, nested). `from` is the TBA itself,
// not the caller's own EOA - the TBA holds the NFT, the connected wallet
// is just the one authorized to tell it to move.
export function buildSendNftTx(
  tbaAddress: string,
  nftContractAddress: string,
  nftTokenId: string,
  to: string,
): { to: string; data: string } {
  const transferData = erc721Interface.encodeFunctionData("safeTransferFrom", [
    tbaAddress,
    to,
    nftTokenId,
  ]);
  return {
    to: tbaAddress,
    data: accountInterface.encodeFunctionData("execute", [
      nftContractAddress,
      BigInt(0),
      transferData,
      OPERATION_CALL,
    ]),
  };
}
