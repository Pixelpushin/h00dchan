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
import { CONTRACT, CHAIN_ID_HEX, DEFAULT_RPC_URL } from "@/lib/chain";
import * as tbaKit from "@pixelpushin/tba-kit";
import { Interface } from "ethers";

// execute()/transfer() encoding - local to h00dchan, not in @pixelpushin/
// tba-kit (that package's README explicitly says spend/execute isn't in
// there yet: "no project in this ecosystem has built the frontend for it
// yet"). Every Tokenbound V3 account exposes execute(address,uint256,
// bytes,uint8) - confirmed live against the deployed implementation on
// Robinhood Chain (0x51945447, its 4-byte selector, is present in the
// contract's own eth_getCode dump, not just assumed from the ABI).
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

// Both of these used to have NO Alchemy routing at all - confirmed live as
// the real root cause of a "not registering in app" report: a real
// 148-token wallet's /api/wallet-tokens response came back with every
// single token failing to resolve, reproducibly, even in isolation,
// because this file's whole per-token TBA/activation lookup ran entirely
// on the plain public RPC (see lib/chain.ts's DEFAULT_RPC_URL for the full
// story - lib/alphaBotEngagement.ts's own separate TBA-resolution path
// already used Alchemy, this one never did).
export async function computeTbaAddress(
  tokenId: number | string | bigint,
): Promise<string> {
  return tbaKit.computeTbaAddress({
    tokenContract: CONTRACT,
    tokenId,
    chainIdHex: CHAIN_ID_HEX,
    rpcUrl: DEFAULT_RPC_URL,
  });
}

export async function isTbaActivated(tbaAddress: string): Promise<boolean> {
  return tbaKit.isTbaActivated(tbaAddress, DEFAULT_RPC_URL);
}

// {to, data} for the registry's createAccount(...) - the connected wallet
// signs and sends this itself. The implementation contract deployed on
// Robinhood Chain 2026-08-17 (confirmed live via eth_getCode), so this is
// now safe to wire up to a real UI action.
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

// Same idea, but for an ERC-20 balance the TBA holds: execute() tells the
// TBA to call transfer() on the token contract itself, moving tokens out
// of the TBA's own balance.
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

// Same idea, but for an NFT (ERC-721) the TBA holds - including another
// HOODCHAN nested inside this one's own wallet, the exact case the
// nested-holding XP bonus rewards locking into a TBA in the first place;
// this is the other half of that feature, letting it come back out. `from`
// is the TBA itself, not the caller's own EOA - the TBA holds the NFT, the
// connected wallet is just the one authorized to tell it to move.
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
