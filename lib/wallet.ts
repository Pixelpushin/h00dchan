// Wallet layer on top of Reown AppKit (see lib/appkit.ts for the client
// config: custom Robinhood Chain network, ethers adapter, project ID from
// NEXT_PUBLIC_REOWN_PROJECT_ID). This used to be raw EIP-1193 calls against
// window.ethereum directly - extension-only, no mobile/QR support. AppKit's
// connect modal now handles both injected extensions AND WalletConnect
// (QR/mobile) through one unified flow.
//
// Function names/signatures are kept identical to that previous
// implementation on purpose: app/page.tsx and lib/usePersona.ts both call
// these as plain async functions from outside any component body -
// usePersona.ts's `reauthorize` in particular runs from inside a
// form-submit handler, not React render, so it can't call AppKit's React
// hooks (useAppKitAccount, useAppKitProvider, ...) directly. Reimplementing
// the internals here on top of AppKit's imperative API (modal.open(),
// modal.subscribeAccount(), modal.getWalletProvider()) means neither caller
// needs to change at all.
import { BrowserProvider, type Eip1193Provider } from "ethers";
import { getAppKit } from "@/lib/appkit";

// Opens the AppKit connect modal (lists both WalletConnect/QR for mobile
// and any detected injected extension in one screen) and resolves once an
// account is connected. Rejects if the user closes the modal without
// connecting, or if AppKit fails to open at all (e.g. a bad/missing
// Project ID).
export async function connectWallet(): Promise<string> {
  const modal = getAppKit();

  const existing = modal.getAccount();
  if (existing?.isConnected && existing.address) {
    return existing.address;
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribeAccount();
      unsubscribeState();
      run();
    };

    const unsubscribeAccount = modal.subscribeAccount((state) => {
      if (state.isConnected && state.address) {
        finish(() => resolve(state.address as string));
      }
    });

    // If the modal closes without ever reporting a connected account, the
    // user dismissed it - reject rather than leaving the caller's promise
    // hanging forever.
    const unsubscribeState = modal.subscribeState((state) => {
      if (state.open) return;
      const account = modal.getAccount();
      if (account?.isConnected && account.address) {
        finish(() => resolve(account.address as string));
      } else {
        finish(() => reject(new Error("Wallet connection cancelled.")));
      }
    });

    modal.open({ view: "Connect" }).catch((err: unknown) => {
      finish(() =>
        reject(
          err instanceof Error
            ? err
            : new Error("Unable to open the wallet connect modal."),
        ),
      );
    });
  });
}

// Raw personal_sign (EIP-191) - proves control of `address` over a
// human-readable message. Used for the "claim and post as your NFT" flow:
// the caller builds the message (see lib/persona.ts's buildAuthMessage, so
// client and server always agree on the exact string) and this just asks
// the connected wallet to sign it.
//
// signer.signMessage() on an ethers BrowserProvider issues a standard
// EIP-191 personal_sign request under the hood, and lib/auth-server.ts's
// `verifyMessage` (also ethers) is the matched inverse of that same
// operation - both come from the same library's implementation of one
// standard, so they're guaranteed to agree regardless of which wallet is on
// the other end of the connection. NOT independently verified against a
// live wallet's actual signature output in this dev environment (no
// extension/WalletConnect session was available to complete a real
// connect+sign round-trip here) - test this for real with an actual wallet
// before treating the claim flow as production-verified end-to-end.
export async function signMessage(
  address: string,
  message: string,
): Promise<string> {
  const modal = getAppKit();
  const account = modal.getAccount();
  if (!account?.isConnected) {
    throw new Error("No wallet connected - click Connect Wallet first.");
  }

  const walletProvider = modal.getWalletProvider() as
    Eip1193Provider | undefined;
  if (!walletProvider) {
    throw new Error("No wallet provider available - reconnect your wallet.");
  }

  const browserProvider = new BrowserProvider(walletProvider);
  const signer = await browserProvider.getSigner(address);
  return signer.signMessage(message);
}

// Sends a real on-chain transaction from the connected wallet - used for
// TBA wallet actions (activate via createAccount, send via execute()).
// Same BrowserProvider/getSigner pattern as signMessage, just
// sendTransaction instead of signMessage. Returns the tx hash immediately
// (not waiting for confirmation) so the caller can decide how to show
// pending state; wait for it with a receipt poll if needed.
export async function sendTransaction(
  address: string,
  tx: { to: string; data: string; value?: string },
): Promise<string> {
  const modal = getAppKit();
  const account = modal.getAccount();
  if (!account?.isConnected) {
    throw new Error("No wallet connected - click Connect Wallet first.");
  }

  const walletProvider = modal.getWalletProvider() as
    Eip1193Provider | undefined;
  if (!walletProvider) {
    throw new Error("No wallet provider available - reconnect your wallet.");
  }

  const browserProvider = new BrowserProvider(walletProvider);
  const signer = await browserProvider.getSigner(address);
  const response = await signer.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ?? BigInt(0),
  });
  return response.hash;
}

// Fires whenever AppKit's connected account changes - covers both a
// same-provider account switch and a full disconnect (empty array), same
// contract as the old `accountsChanged` EIP-1193 event this replaces.
//
// Also fires once, synchronously, with whatever AppKit already knows at
// subscribe time - AppKit persists connection state across reloads, but
// without this a caller had no way to learn about a restored session
// without the user clicking "Connect Wallet" again (which then *felt* like
// logging in again every reload, even though the modal itself resolved
// instantly since AppKit was already connected under the hood). Callers
// that only care about real changes can ignore the first call if it matches
// what they already knew.
export function onAccountsChanged(
  callback: (accounts: string[]) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const modal = getAppKit();
  const current = modal.getAccount();
  callback(current?.isConnected && current.address ? [current.address] : []);
  return modal.subscribeAccount((state) => {
    callback(state.isConnected && state.address ? [state.address] : []);
  });
}

export function disconnectWallet(): Promise<void> {
  return getAppKit().disconnect();
}
