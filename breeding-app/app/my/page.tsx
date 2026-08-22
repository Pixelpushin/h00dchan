"use client";

// "My tokens" page - list/unlist ANY of your tokens, across all three
// allowlisted collections, as a public sire with a CHAN price (v2:
// generalized from the superseded v1 HOODCHAN-only siring UI, which also
// had a now-dropped ETH price field - CHAN is the only fee currency, see
// the design spec's "Fees" section). `listed` is always an explicit
// boolean, shown separately from price - a price of 0 while listed means
// "free but listed", never "unlisted" (see BreedingController's own
// SiringListing doc comment on why "price 0" must never silently mean
// "available by default").
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits, parseUnits } from "ethers";
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";
import {
  connectWallet,
  onAccountsChanged,
  sendTransaction,
} from "@/lib/wallet";
import {
  buildListSiringTx,
  buildUnlistSiringTx,
} from "@/lib/breedingController";
import { BREEDING_CONTROLLER_CONTRACT } from "@/lib/config";
import { collectionLabel, type CooldownStatus } from "@/lib/collections";

interface TokenRow {
  collection: string;
  kind: string;
  tokenId: string;
  name: string;
  image: string;
  cooldown: CooldownStatus;
  listed: boolean;
  price: string;
}

interface GirlfriendRow {
  tokenId: string;
  tbaAddress: string;
  nestedBabyIds: string[];
}

interface MyData {
  tokens: TokenRow[];
  girlfriends: GirlfriendRow[];
  girlfriendsPending: boolean;
  breedingControllerPending: boolean;
  error?: string;
}

function cooldownLabel(cooldown: CooldownStatus): string {
  if (!cooldown.onCooldown) return "Ready to breed";
  const mins = Math.ceil(cooldown.secondsRemaining / 60);
  if (mins < 60) return `Cooldown: ${mins}m left`;
  const hours = Math.ceil(mins / 60);
  if (hours < 48) return `Cooldown: ${hours}h left`;
  return `Cooldown: ${Math.ceil(hours / 24)}d left`;
}

function ListingEditor({
  token,
  onSaved,
}: {
  token: TokenRow;
  onSaved: () => void;
}) {
  const [price, setPrice] = useState(formatUnits(token.price, 18));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!BREEDING_CONTROLLER_CONTRACT) return;
    setBusy(true);
    setErr(null);
    try {
      const address = await connectWallet();
      // listSiring(collection, tokenId, price: uint128) - the real
      // on-chain signature (contracts/src/BreedingController.sol). CHAN is
      // the only fee currency (the v1 dual-currency ETH path is cut from
      // scope) and this now works for a token from ANY of the three
      // allowlisted collections, not just HOODCHAN.
      const tx = buildListSiringTx(
        token.collection,
        token.tokenId,
        parseUnits(price || "0", 18),
      );
      await sendTransaction(address, tx);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  async function delist() {
    if (!BREEDING_CONTROLLER_CONTRACT) return;
    setBusy(true);
    setErr(null);
    try {
      const address = await connectWallet();
      await sendTransaction(
        address,
        buildUnlistSiringTx(token.collection, token.tokenId),
      );
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delist.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 mt-1">
      <div className="flex gap-1 items-center">
        <input
          className="hc-form-input text-xs w-20"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="CHAN"
        />
      </div>
      <div className="flex gap-1">
        <button
          className="hc-button hc-button-ghost text-xs"
          disabled={busy}
          onClick={save}
        >
          {token.listed ? "Update" : "List"}
        </button>
        {token.listed && (
          <button
            className="hc-button hc-button-ghost text-xs"
            disabled={busy}
            onClick={delist}
          >
            Delist
          </button>
        )}
      </div>
      {err && (
        <span className="text-xs" style={{ color: "var(--hc-danger)" }}>
          {err}
        </span>
      )}
    </div>
  );
}

export default function MyPage() {
  const [address, setAddress] = useState<string | null>(null);
  const [data, setData] = useState<MyData | null>(null);

  const load = useCallback(() => {
    if (!address) return;
    fetch(`/api/wallet/${address}/my`)
      .then((res) => res.json())
      .then(setData)
      .catch((err) => setData({ error: String(err) } as MyData));
  }, [address]);

  useEffect(
    () => onAccountsChanged((accounts) => setAddress(accounts[0] ?? null)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!address) {
    return (
      <main className="mx-auto max-w-4xl w-full px-4 py-6">
        <button
          className="hc-button"
          onClick={() => connectWallet().catch(() => {})}
        >
          Connect Wallet
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl w-full px-4 py-6 flex flex-col gap-6">
      <section>
        <h1 className="hc-title text-2xl mb-2">Your tokens (siring)</h1>
        {data?.breedingControllerPending && (
          <ConfigPendingNotice what="The BreedingController contract" />
        )}
        {!data && (
          <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
            Loading...
          </p>
        )}
        {data && data.tokens.length === 0 && (
          <div
            className="hc-box p-4 text-sm"
            style={{ color: "var(--hc-muted)" }}
          >
            You don&apos;t own any breedable tokens (HOODCHAN, Girlfriend, or
            Baby) yet.
          </div>
        )}
        {data && data.tokens.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {data.tokens.map((t) => (
              <div key={`${t.collection}-${t.tokenId}`} className="hc-card">
                {t.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.image}
                    alt={t.name}
                    className="w-full aspect-square object-cover"
                  />
                ) : (
                  <div
                    className="w-full aspect-square"
                    style={{ background: "var(--hc-box-alt)" }}
                  />
                )}
                <div className="hc-card-body">
                  <span className="font-bold text-sm truncate">{t.name}</span>
                  <div className="flex flex-wrap gap-1">
                    <span className="hc-badge">
                      {collectionLabel(t.collection)}
                    </span>
                    <span className="hc-badge">
                      {cooldownLabel(t.cooldown)}
                    </span>
                  </div>
                  {!data.breedingControllerPending && (
                    <ListingEditor token={t} onSaved={load} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h1 className="hc-title text-2xl mb-2">Your Girlfriends (nested)</h1>
        {data?.girlfriendsPending && (
          <ConfigPendingNotice what="The HOODCHAN_GIRLFRIENDS contract" />
        )}
        {data && !data.girlfriendsPending && data.girlfriends.length === 0 && (
          <div
            className="hc-box p-4 text-sm"
            style={{ color: "var(--hc-muted)" }}
          >
            You don&apos;t own any Girlfriends yet.
          </div>
        )}
        {data && data.girlfriends.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {data.girlfriends.map((g) => (
              <div key={g.tokenId} className="hc-card">
                <div className="hc-card-body">
                  <span className="font-bold text-sm">
                    Girlfriend #{g.tokenId}
                  </span>
                  {/* Purely informational - nesting is no longer a
                      breeding-flow gate (see lib/girlfriends.ts's header:
                      the v1 NESTED_CAP mechanic is dead, not just moved). */}
                  {g.nestedBabyIds.length > 0 && (
                    <>
                      <span className="hc-badge">
                        {g.nestedBabyIds.length} nested
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {g.nestedBabyIds.map((babyId) => (
                          <Link
                            key={babyId}
                            href={`/baby/${babyId}`}
                            className="hc-link text-xs"
                          >
                            #{babyId}
                          </Link>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {data?.error && <div className="hc-error-box">{data.error}</div>}
    </main>
  );
}
