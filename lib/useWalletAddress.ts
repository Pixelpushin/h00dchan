"use client";

// Shared "is a wallet connected, and to what address" hook - both the
// site-wide header widget (app/components/WalletHeaderWidget.tsx) and the
// home page's token grid (app/components/HomeClient.tsx) need this, and
// since AppKit is a single module-scoped singleton (see lib/appkit.ts),
// two independent subscribers here correctly see the same live state with
// no shared React context or prop drilling required.
import { useEffect, useState } from "react";
import { onAccountsChanged } from "@/lib/wallet";

export function useWalletAddress(): string | null {
  const [address, setAddress] = useState<string | null>(null);

  // onAccountsChanged fires once immediately with whatever AppKit already
  // knows (restoring a session across reload/nav with no re-prompt), then
  // again on every real change - see lib/wallet.ts.
  useEffect(() => {
    return onAccountsChanged((accounts) => {
      setAddress(accounts?.length ? accounts[0] : null);
    });
  }, []);

  return address;
}
