// Raw EIP-1193 calls against window.ethereum - no viem/wagmi/WalletConnect
// dependency. Ported nearly verbatim from hoodies-fight/src/wallet.js:
// same zero-dependency philosophy, same target chain (Robinhood Chain),
// same connect/switch pattern. Everything here is already standard on any
// injected wallet (MetaMask, Rabby, Coinbase Wallet, Brave Wallet, etc).
// Mobile/QR wallet support via WalletConnect would need a project ID from
// cloud.reown.com, which nobody has set up yet - out of scope for now.

export interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

interface ProviderRpcError extends Error {
  code?: number;
}

const ROBINHOOD_CHAIN = {
  chainIdHex: "0x1237", // 4663
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

async function ensureRobinhoodChain(provider: EthereumProvider): Promise<void> {
  const currentChainId = await provider.request({ method: "eth_chainId" });
  if (currentChainId === ROBINHOOD_CHAIN.chainIdHex) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ROBINHOOD_CHAIN.chainIdHex }],
    });
  } catch (err) {
    // 4902 = chain not added to this wallet yet - add it, then switch.
    const rpcErr = err as ProviderRpcError;
    if (rpcErr?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: ROBINHOOD_CHAIN.chainIdHex,
            chainName: ROBINHOOD_CHAIN.chainName,
            nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
            rpcUrls: ROBINHOOD_CHAIN.rpcUrls,
            blockExplorerUrls: ROBINHOOD_CHAIN.blockExplorerUrls,
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export async function connectWallet(): Promise<string> {
  if (!hasInjectedWallet()) {
    throw new Error(
      "No wallet found - install MetaMask, Rabby, or another browser wallet extension.",
    );
  }
  const provider = window.ethereum as EthereumProvider;
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.length) throw new Error("No account returned by wallet.");
  await ensureRobinhoodChain(provider);
  return accounts[0];
}

// Raw personal_sign - proves control of `address` over a human-readable
// message. Used for the "claim and post as your NFT" flow: the caller
// builds the message (see lib/persona.ts's buildAuthMessage, so client and
// server always agree on the exact string) and this just asks the wallet
// to sign it.
export async function signMessage(
  address: string,
  message: string,
): Promise<string> {
  if (!hasInjectedWallet()) {
    throw new Error(
      "No wallet found - install MetaMask, Rabby, or another browser wallet extension.",
    );
  }
  const provider = window.ethereum as EthereumProvider;
  const signature = (await provider.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;
  return signature;
}

export function onAccountsChanged(
  callback: (accounts: string[]) => void,
): () => void {
  if (!hasInjectedWallet()) return () => {};
  const provider = window.ethereum as EthereumProvider;
  const handler = (...args: unknown[]) => callback(args[0] as string[]);
  provider.on("accountsChanged", handler);
  return () => provider.removeListener("accountsChanged", handler);
}
