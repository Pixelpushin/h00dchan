"use client";

// Single atomic breed() flow - see
// contracts/src/BreedingController.sol's ACCEPTED TRADEOFF note for why
// this is one tx now, not the superseded v1 commitBreed()/revealBreed()
// two-step: the design spec explicitly accepts a predictable/simulable
// seed ("you get what you get") in exchange for deleting the whole
// escrow/lock/expiry/resume machinery this page used to need. This page
// specifically breeds a HOODCHAN token (browsed here as the SIRE, listed
// for siring by its owner - or free if the caller owns it too) against one
// of the caller's own Girlfriends (the MATRON - ownership of the matron is
// the only mandatory check, see the design spec's "Ownership rule").
//
// UI-WAVE TODO (flagged, not fixed here - see the task's minimal-mechanical-
// fix scope): this only covers the HOODCHAN-sire x own-Girlfriend-matron
// case. The v2 design spec allows ANY allowlisted collection (including
// Babies) in EITHER role - a full matron/sire picker across all three
// collections, plus live sex-tag/same-sex-fee-tier display (this page
// currently assumes HOODCHAN=Male/Girlfriend=Female and therefore never
// same-sex, which is only true for this one specific pairing), belongs to
// the next UI wave.
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits } from "ethers";
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";
import {
  connectWallet,
  onAccountsChanged,
  sendTransaction,
} from "@/lib/wallet";
import { buildApproveChanTx } from "@/lib/chanToken";
import { buildBreedTx, previewBreedFee } from "@/lib/breedingController";
import {
  GIRLFRIENDS_CONTRACT,
  HOODCHAN_CONTRACT,
  DEFAULT_BIRTH_FEE,
  DEFAULT_SAME_SEX_FEE_MULTIPLIER,
} from "@/lib/config";
import type { TokenMetadata } from "@/lib/chain";

interface SireInfo {
  pending?: boolean;
  hoodchanId: string;
  owner: string;
  price: string;
  listed: boolean;
  genesSet: boolean;
  breedCount: number;
  cooldownEnd: string;
  name: string;
  image: string;
  error?: string;
}

interface ResolvedSlot {
  slot: string;
  byte: number;
  name: string;
}

interface BreedingRecord {
  babyId: string;
  imageUrl: string;
  slots: ResolvedSlot[];
}

type Stage =
  | "idle"
  | "approving"
  | "breeding"
  | "waiting"
  | "generating"
  | "done"
  | "error";

export default function BreedPage({
  params,
}: {
  params: Promise<{ hoodchanId: string }>;
}) {
  const { hoodchanId } = use(params);
  const [sire, setSire] = useState<SireInfo | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [girlfriends, setGirlfriends] = useState<TokenMetadata[]>([]);
  const [girlfriendsPending, setGirlfriendsPending] = useState(false);
  const [matronId, setMatronId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [baby, setBaby] = useState<BreedingRecord | null>(null);

  useEffect(() => {
    fetch(`/api/sire/${hoodchanId}`)
      .then((res) => res.json())
      .then(setSire)
      .catch((err) => setSire({ error: String(err) } as SireInfo));
  }, [hoodchanId]);

  useEffect(
    () => onAccountsChanged((accounts) => setAddress(accounts[0] ?? null)),
    [],
  );

  useEffect(() => {
    if (!address) return;
    fetch(`/api/wallet/${address}/girlfriends`)
      .then((res) => res.json())
      .then((data: { pending: boolean; girlfriends: TokenMetadata[] }) => {
        setGirlfriendsPending(data.pending);
        setGirlfriends(data.girlfriends ?? []);
      })
      .catch(() => setGirlfriends([]));
  }, [address]);

  const isFree = Boolean(
    sire && address && sire.owner?.toLowerCase() === address.toLowerCase(),
  );

  // HOODCHAN (sire, this page) is always Male, Girlfriends (matron) always
  // Female per the design spec's fixed CollectionSex config - so this
  // specific pairing is never same-sex ("test tube baby"), and only pays
  // the flat (unmultiplied) birth fee. See this file's header TODO for why
  // a full cross-collection picker would need a live sex-tag read instead.
  const feePreview = sire
    ? previewBreedFee({
        birthFee: DEFAULT_BIRTH_FEE,
        sameSexFeeMultiplier: DEFAULT_SAME_SEX_FEE_MULTIPLIER,
        matronSex: false,
        sireSex: true,
        sireCallerOwned: isFree,
        listedPrice: BigInt(sire.price),
      })
    : null;

  const pollForResult = useCallback(
    async (
      txHash: string,
    ): Promise<{ state: "ready"; baby: BreedingRecord }> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(`/api/breed/${txHash}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.state === "ready") return { state: "ready", baby: data.baby };
        // "pending" - keep polling.
      }
      throw new Error("Timed out waiting for the breeding transaction.");
    },
    [],
  );

  async function handleBreed() {
    if (!sire || !address || !matronId || !GIRLFRIENDS_CONTRACT) return;
    if (!isFree && !confirmed) {
      setError("Confirm the price above before breeding.");
      return;
    }
    setError(null);
    try {
      const maxSiringFee = isFree ? BigInt(0) : BigInt(sire.price);
      const totalDebit = feePreview?.totalCallerDebit ?? BigInt(0);

      if (totalDebit > BigInt(0)) {
        setStage("approving");
        // Approve EXACTLY the previewed total debit, never an unlimited
        // allowance - `maxSiringFee` below is the real slippage bound
        // (BreedingController.breed() reverts SiringFeeTooHigh if the
        // sire's owner re-listed at a higher price in the meantime), but
        // an unlimited approval would still let a MALICIOUS sire owner who
        // front-runs with a higher listing (below the revert bound) pull
        // more than what was shown here if this approval weren't also
        // capped.
        const approveTx = buildApproveChanTx(
          process.env.NEXT_PUBLIC_BREEDING_CONTROLLER_CONTRACT as string,
          totalDebit,
        );
        await sendTransaction(address, approveTx);
      }

      setStage("breeding");
      // matronCollection/matronId = the caller's own Girlfriend (the only
      // mandatory ownership check per the design spec); sireCollection/
      // sireId = this page's browsed HOODCHAN token (route param).
      const tx = buildBreedTx(
        GIRLFRIENDS_CONTRACT,
        matronId,
        HOODCHAN_CONTRACT,
        hoodchanId,
        maxSiringFee,
      );
      const txHash = await sendTransaction(address, tx);

      setStage("waiting");
      const result = await pollForResult(txHash);
      setBaby(result.baby);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Breeding failed.");
      setStage("error");
    }
  }

  if (!sire) {
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6">
        <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
          Loading sire...
        </p>
      </main>
    );
  }

  if (sire.pending) {
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6">
        <ConfigPendingNotice what="The BreedingController contract" />
      </main>
    );
  }

  if (sire.error) {
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6">
        <div className="hc-error-box">{sire.error}</div>
      </main>
    );
  }

  if (stage === "done" && baby) {
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col gap-4 items-center text-center">
        <h1 className="hc-title text-2xl">Offspring sired</h1>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={baby.imageUrl}
          alt="Offspring"
          className="w-64 h-64 object-cover rounded-lg hc-box"
        />
        <div className="flex flex-wrap gap-2 justify-center">
          {baby.slots.map((s) => (
            <span key={s.slot} className="hc-badge">
              {s.slot}: {s.name}
            </span>
          ))}
        </div>
        <Link href={`/baby/${baby.babyId}`} className="hc-button">
          View full offspring
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col gap-4">
      <div className="flex gap-4 items-center hc-box p-4">
        {sire.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={sire.image}
            alt={sire.name}
            className="w-24 h-24 object-cover rounded"
          />
        ) : (
          <div
            className="w-24 h-24 rounded"
            style={{ background: "var(--hc-box-alt)" }}
          />
        )}
        <div>
          <h1 className="hc-title text-xl">{sire.name}</h1>
          <div className="flex gap-2 mt-1">
            <span className="hc-badge hc-badge-chan">
              {formatUnits(sire.price, 18)} CHAN
            </span>
          </div>
          {!sire.genesSet && (
            <p className="text-xs mt-1" style={{ color: "var(--hc-danger)" }}>
              This anon&apos;s genes haven&apos;t been synced yet - breeding
              will revert until they are.
            </p>
          )}
        </div>
      </div>

      {!address && (
        <button
          className="hc-button"
          onClick={() => connectWallet().catch(() => {})}
        >
          Connect Wallet to breed
        </button>
      )}

      {address && girlfriendsPending && (
        <ConfigPendingNotice what="The HOODCHAN_GIRLFRIENDS contract" />
      )}

      {address && !girlfriendsPending && girlfriends.length === 0 && (
        <div
          className="hc-box p-4 text-sm"
          style={{ color: "var(--hc-muted)" }}
        >
          You don&apos;t own any Girlfriends yet - you need one to breed with
          this sire.
        </div>
      )}

      {address && girlfriends.length > 0 && (
        <div className="hc-box p-4 flex flex-col gap-3">
          <label className="text-sm font-bold">Pick a matron</label>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {girlfriends.map((g) => (
              <button
                key={g.tokenId}
                onClick={() => {
                  setMatronId(g.tokenId);
                  setConfirmed(false);
                }}
                className="hc-card"
                style={
                  matronId === g.tokenId
                    ? { borderColor: "var(--hc-header-to)", borderWidth: 2 }
                    : undefined
                }
              >
                {g.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={g.image}
                    alt={g.name}
                    className="w-full aspect-square object-cover"
                  />
                ) : (
                  <div
                    className="w-full aspect-square"
                    style={{ background: "var(--hc-box-alt)" }}
                  />
                )}
                <span className="text-xs p-1 truncate">{g.name}</span>
              </button>
            ))}
          </div>

          {isFree && (
            <p
              className="text-sm font-bold"
              style={{ color: "var(--hc-greentext)" }}
            >
              You own this sire and the matron - no siring fee applies (the flat
              birth fee still does).
            </p>
          )}

          {matronId && feePreview && (
            <div
              className="hc-box p-3 flex flex-col gap-2"
              style={{ background: "var(--hc-box-alt)" }}
            >
              <p className="text-sm">
                You will pay up to{" "}
                <strong>
                  {formatUnits(feePreview.totalCallerDebit, 18)} CHAN
                </strong>{" "}
                total (birth fee + siring fee + 8% protocol fee). If the
                sire&apos;s owner raises the price before your tx lands, the
                transaction reverts instead of charging you more.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I confirm this price
              </label>
            </div>
          )}

          <button
            className="hc-button"
            disabled={
              !matronId ||
              (!isFree && !confirmed) ||
              stage === "approving" ||
              stage === "breeding" ||
              stage === "waiting" ||
              stage === "generating"
            }
            onClick={handleBreed}
          >
            {stage === "approving" && "Approving CHAN..."}
            {stage === "breeding" && "Sending breed tx..."}
            {stage === "waiting" && "Waiting for breed to land..."}
            {stage === "generating" && "Generating offspring art..."}
            {(stage === "idle" || stage === "error") && "Breed"}
          </button>

          {stage === "error" && error && (
            <div className="hc-error-box">{error}</div>
          )}
        </div>
      )}
    </main>
  );
}
