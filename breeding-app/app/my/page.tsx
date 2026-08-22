"use client";

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
  buildSetSiringPriceTx,
  buildDelistSiringTx,
} from "@/lib/breedingController";
import { BREEDING_CONTROLLER_CONTRACT } from "@/lib/config";

interface HoodchanRow {
  tokenId: string;
  name: string;
  image: string;
  listed: boolean;
  chanPrice: string;
  ethPrice: string;
}

interface GirlfriendRow {
  tokenId: string;
  tbaAddress: string;
  nestedBabyIds: string[];
  atCap: boolean;
}

interface MyData {
  hoodchans: HoodchanRow[];
  girlfriends: GirlfriendRow[];
  girlfriendsPending: boolean;
  breedingControllerPending: boolean;
  maxNestedOffspring: number;
  error?: string;
}

function ListingEditor({
  hoodchan,
  onSaved,
}: {
  hoodchan: HoodchanRow;
  onSaved: () => void;
}) {
  const [chan, setChan] = useState(formatUnits(hoodchan.chanPrice, 18));
  const [eth, setEth] = useState(formatUnits(hoodchan.ethPrice, 18));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!BREEDING_CONTROLLER_CONTRACT) return;
    setBusy(true);
    setErr(null);
    try {
      const address = await connectWallet();
      // setSiringPrice(fatherTokenId, chanPrice: uint128, ethPrice: uint128)
      // - the real on-chain signature (contracts/src/BreedingController.sol).
      // ETH is stored regardless of Upgraded status; it's only USABLE for a
      // father whose upgradedAllowlist is true (checked at commitBreed
      // time), so setting a nonzero ETH price on a non-Upgraded token is
      // harmless, just unusable until/unless that changes.
      const tx = buildSetSiringPriceTx(
        hoodchan.tokenId,
        parseUnits(chan || "0", 18),
        parseUnits(eth || "0", 18),
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
      await sendTransaction(address, buildDelistSiringTx(hoodchan.tokenId));
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
          value={chan}
          onChange={(e) => setChan(e.target.value)}
          placeholder="CHAN"
        />
        <input
          className="hc-form-input text-xs w-20"
          value={eth}
          onChange={(e) => setEth(e.target.value)}
          placeholder="ETH (Upgraded only)"
        />
      </div>
      <div className="flex gap-1">
        <button
          className="hc-button hc-button-ghost text-xs"
          disabled={busy}
          onClick={save}
        >
          {hoodchan.listed ? "Update" : "List"}
        </button>
        {hoodchan.listed && (
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
        <h1 className="hc-title text-2xl mb-2">Your Girlfriends</h1>
        {!data && (
          <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
            Loading...
          </p>
        )}
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
              <div
                key={g.tokenId}
                className="hc-card"
                // Real 5-cap enforcement (contracts/src/BreedingController.sol's
                // NESTED_CAP, checked live at commitBreed AND again at
                // revealBreed) - a mother at cap can't sire again until a
                // nested offspring is moved out of her TBA, so this greys
                // her out here as the same real constraint, not a cosmetic
                // guess.
                style={
                  g.atCap ? { opacity: 0.5, filter: "grayscale(1)" } : undefined
                }
              >
                <div className="hc-card-body">
                  <span className="font-bold text-sm">
                    Girlfriend #{g.tokenId}
                  </span>
                  <span
                    className="hc-badge"
                    style={
                      g.atCap
                        ? {
                            color: "var(--hc-urgent)",
                            borderColor: "var(--hc-urgent)",
                          }
                        : undefined
                    }
                  >
                    {g.nestedBabyIds.length}/{data.maxNestedOffspring} nested
                    {g.atCap ? " - full" : ""}
                  </span>
                  {g.nestedBabyIds.length > 0 && (
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
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h1 className="hc-title text-2xl mb-2">Your HOODCHANs (siring)</h1>
        {data?.breedingControllerPending && (
          <ConfigPendingNotice what="The BreedingController contract" />
        )}
        {data && data.hoodchans.length === 0 && (
          <div
            className="hc-box p-4 text-sm"
            style={{ color: "var(--hc-muted)" }}
          >
            You don&apos;t own any HOODCHANs.
          </div>
        )}
        {data && data.hoodchans.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {data.hoodchans.map((h) => (
              <div key={h.tokenId} className="hc-card">
                {h.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={h.image}
                    alt={h.name}
                    className="w-full aspect-square object-cover"
                  />
                ) : (
                  <div
                    className="w-full aspect-square"
                    style={{ background: "var(--hc-box-alt)" }}
                  />
                )}
                <div className="hc-card-body">
                  <span className="font-bold text-sm truncate">{h.name}</span>
                  {!data.breedingControllerPending && (
                    <ListingEditor hoodchan={h} onSaved={load} />
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
