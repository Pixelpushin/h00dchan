"use client";

// Single atomic breed() flow, generalized to the v2 design spec's
// collection-symmetric model: matron AND sire can each be a token from ANY
// of the three allowlisted collections (HOODCHAN, Girlfriends, Babies), in
// EITHER role - see the design spec's "Collections and the breedable
// allowlist" section. This REPLACES the superseded (already single-tx, but
// HOODCHAN-sire x own-Girlfriend-matron ONLY) previous version of this page
// at the old `/breed/[hoodchanId]` route.
//
// Route param (collection, tokenId) is the token the caller arrived here
// browsing - almost always a publicly listed sire clicked from the home
// page - and is pre-selected into the SIRE picker below. Nothing about the
// route param is load-bearing to which ROLE it fills though: the sire
// picker also lets the caller swap in one of their OWN tokens (free, no
// siring fee) instead, and the matron picker is always the caller's own
// tokens across all three collections (matron ownership is the ONLY
// mandatory ownership check, per the design spec's "Ownership rule").
import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatUnits } from "ethers";
import { ConfigPendingNotice } from "@/app/components/ConfigPendingNotice";
import {
  connectWallet,
  onAccountsChanged,
  sendTransaction,
} from "@/lib/wallet";
import { buildApproveChanTx } from "@/lib/chanToken";
import {
  buildBreedTx,
  buildClearStaleListingTx,
  previewBreedFee,
} from "@/lib/breedingController";
import {
  BREEDING_CONTROLLER_CONTRACT,
  DEFAULT_BIRTH_FEE,
  DEFAULT_SAME_SEX_FEE_MULTIPLIER,
} from "@/lib/config";
import { collectionLabel, type CooldownStatus } from "@/lib/collections";
import type { OwnedBreedableToken } from "@/lib/collections";
import type { ListingResponse } from "@/app/api/listings/route";
import type { ResolvedGenomeSlot } from "@/lib/traitRegistry";

interface SireLiveInfo {
  pending?: boolean;
  collection: string;
  kind: string;
  tokenId: string;
  owner: string;
  isMale: boolean;
  genesSet: boolean;
  price: string;
  listed: boolean;
  // True when `listing.listed` is true but `listing.lister !== ownerOf` -
  // i.e. the sire was transferred away after being listed and the listing
  // was never cleaned up. See app/api/sire/[collection]/[tokenId]/route.ts's
  // stale-cross-check.
  stale?: boolean;
  cooldown: CooldownStatus;
  name: string;
  image: string;
  error?: string;
}

interface BreedingRecord {
  babyId: string;
  imageUrl: string;
  slots: ResolvedGenomeSlot[];
  babyIsMale: boolean;
  isTestTubeBaby: boolean;
}

type Stage =
  | "idle"
  | "approving"
  | "breeding"
  | "waiting"
  | "generating"
  | "done"
  | "error";

function cooldownLabel(cooldown: CooldownStatus | null): string {
  if (!cooldown) return "";
  if (!cooldown.onCooldown) return "Ready to breed";
  const mins = Math.ceil(cooldown.secondsRemaining / 60);
  if (mins < 60) return `On cooldown - ${mins}m left`;
  const hours = Math.ceil(mins / 60);
  if (hours < 48) return `On cooldown - ${hours}h left`;
  return `On cooldown - ${Math.ceil(hours / 24)}d left`;
}

function isMutantOrLegendary(
  slot: ResolvedGenomeSlot,
): "legendary" | "mutant" | null {
  if (slot.byte < 248) return null;
  return slot.name.startsWith("Legendary") ? "legendary" : "mutant";
}

export default function BreedPage({
  params,
}: {
  params: Promise<{ collection: string; tokenId: string }>;
}) {
  const { collection, tokenId } = use(params);
  const [address, setAddress] = useState<string | null>(null);

  const [browsedInfo, setBrowsedInfo] = useState<SireLiveInfo | null>(null);
  const [ownedTokens, setOwnedTokens] = useState<OwnedBreedableToken[]>([]);
  const [ownedPending, setOwnedPending] = useState(false);
  const [listings, setListings] = useState<ListingResponse[]>([]);

  const [sireSelection, setSireSelection] = useState<{
    collection: string;
    tokenId: string;
  } | null>(null);
  const [sireLiveInfo, setSireLiveInfo] = useState<SireLiveInfo | null>(null);
  const [sireLoading, setSireLoading] = useState(false);

  const [matron, setMatron] = useState<OwnedBreedableToken | null>(null);

  const [sireTab, setSireTab] = useState<"mine" | "listed">("listed");
  const [confirmed, setConfirmed] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [baby, setBaby] = useState<BreedingRecord | null>(null);
  // clearStaleListing is permissionless (see lib/breedingController.ts's
  // buildClearStaleListingTx doc comment) - any connected wallet can send
  // it, not just the sire's current owner. Independent of `stage`/`error`
  // above since it's a side action off the stale-listing notice, not part
  // of the approve+breed flow.
  const [clearingStale, setClearingStale] = useState(false);
  const [clearStaleError, setClearStaleError] = useState<string | null>(null);

  // Live BreedingController fee config (birthFee/sameSexFeeMultiplier) - both
  // owner-configurable post-deploy, so lib/config.ts's DEFAULT_BIRTH_FEE /
  // DEFAULT_SAME_SEX_FEE_MULTIPLIER can drift from the real deployed values.
  // `feeConfig` stays null until the live read resolves; the DEFAULT_* import
  // below is used ONLY to render an approximate preview while loading -
  // `canBreed` requires `feeConfig` to be non-null, so the actual CHAN
  // approval amount (handleBreed's `totalDebit`, derived from `feePreview`)
  // can never be built from the pre-deploy constants.
  const [feeConfig, setFeeConfig] = useState<{
    birthFee: bigint;
    sameSexFeeMultiplier: bigint;
  } | null>(null);
  const [feeConfigLoading, setFeeConfigLoading] = useState(true);
  const [feeConfigError, setFeeConfigError] = useState<string | null>(null);

  useEffect(() => {
    // Same react-hooks/set-state-in-effect note as the owned-tokens effect
    // below.
    Promise.resolve()
      .then(() => setFeeConfigLoading(true))
      .then(() => fetch("/api/fees"))
      .then((res) => res.json())
      .then(
        (data: {
          pending?: boolean;
          birthFee?: string;
          sameSexFeeMultiplier?: string;
          error?: string;
        }) => {
          if (
            data.pending ||
            data.error ||
            !data.birthFee ||
            !data.sameSexFeeMultiplier
          ) {
            setFeeConfigError(
              data.error ??
                "BreedingController fee config is not available yet.",
            );
            return;
          }
          setFeeConfig({
            birthFee: BigInt(data.birthFee),
            sameSexFeeMultiplier: BigInt(data.sameSexFeeMultiplier),
          });
        },
      )
      .catch((err) =>
        setFeeConfigError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setFeeConfigLoading(false));
  }, []);

  // Route-param token's live info - pre-selects it into the sire picker.
  useEffect(() => {
    fetch(`/api/sire/${collection}/${tokenId}`)
      .then((res) => res.json())
      .then((data: SireLiveInfo) => {
        setBrowsedInfo(data);
        if (!data.pending && !data.error) {
          setSireSelection({ collection, tokenId });
        }
      })
      .catch((err) => setBrowsedInfo({ error: String(err) } as SireLiveInfo));
  }, [collection, tokenId]);

  useEffect(
    () => onAccountsChanged((accounts) => setAddress(accounts[0] ?? null)),
    [],
  );

  useEffect(() => {
    if (!address) return;
    // The `.then(() => setOwnedPending(true))` below (rather than a direct
    // synchronous call at the top of this effect) is deliberate - keeps
    // every setState call inside an async callback, not the effect's own
    // synchronous body, per react-hooks/set-state-in-effect.
    Promise.resolve()
      .then(() => setOwnedPending(true))
      .then(() => fetch(`/api/wallet/${address}/tokens`))
      .then((res) => res.json())
      .then((data: { tokens: OwnedBreedableToken[] }) => {
        setOwnedTokens(data.tokens ?? []);
      })
      .catch(() => setOwnedTokens([]))
      .finally(() => setOwnedPending(false));
  }, [address]);

  useEffect(() => {
    fetch("/api/listings")
      .then((res) => res.json())
      .then((data: { listings: ListingResponse[] }) => {
        setListings(data.listings ?? []);
      })
      .catch(() => setListings([]));
  }, []);

  // Fetch authoritative live info for whichever sire is currently selected
  // (route-param default, or a candidate the caller clicked) - this is what
  // both the fee preview and `maxSiringFee`'s slippage bound are derived
  // from, always re-fetched fresh at selection time rather than trusted off
  // a possibly-stale listings-array entry.
  useEffect(() => {
    if (!sireSelection) return;
    // Same react-hooks/set-state-in-effect note as the owned-tokens effect
    // above.
    Promise.resolve()
      .then(() => setSireLoading(true))
      .then(() =>
        fetch(`/api/sire/${sireSelection.collection}/${sireSelection.tokenId}`),
      )
      .then((res) => res.json())
      .then((data: SireLiveInfo) => setSireLiveInfo(data))
      .catch((err) => setSireLiveInfo({ error: String(err) } as SireLiveInfo))
      .finally(() => setSireLoading(false));
  }, [sireSelection]);

  const ownedKey = useMemo(
    () =>
      new Set(
        ownedTokens.map((t) => `${t.collection.toLowerCase()}:${t.tokenId}`),
      ),
    [ownedTokens],
  );

  const listedSireCandidates = useMemo(
    () =>
      listings.filter(
        (l) => !ownedKey.has(`${l.collection.toLowerCase()}:${l.tokenId}`),
      ),
    [listings, ownedKey],
  );

  const isSireOwnedByCaller = Boolean(
    sireLiveInfo &&
    address &&
    sireLiveInfo.owner?.toLowerCase() === address.toLowerCase(),
  );

  // `feeConfig` (from the live `/api/fees` read) is the source of truth once
  // loaded; DEFAULT_BIRTH_FEE/DEFAULT_SAME_SEX_FEE_MULTIPLIER are used ONLY
  // as a display fallback while it's still loading (or failed to load) -
  // `canBreed` below requires `feeConfig` to be non-null, so this fallback
  // path can never be what the user actually approves/pays.
  const feePreview =
    sireLiveInfo && !sireLiveInfo.pending && !sireLiveInfo.error && matron
      ? previewBreedFee({
          birthFee: feeConfig?.birthFee ?? DEFAULT_BIRTH_FEE,
          sameSexFeeMultiplier:
            feeConfig?.sameSexFeeMultiplier ?? DEFAULT_SAME_SEX_FEE_MULTIPLIER,
          matronSex: matron.isMale,
          sireSex: sireLiveInfo.isMale,
          sireCallerOwned: isSireOwnedByCaller,
          listedPrice: BigInt(sireLiveInfo.price || "0"),
        })
      : null;

  const sameCollectionSameToken =
    sireLiveInfo &&
    matron &&
    sireLiveInfo.collection.toLowerCase() === matron.collection.toLowerCase() &&
    sireLiveInfo.tokenId === matron.tokenId;

  // A listing surfaced by /api/listings or /api/sire can be stale (the sire
  // was transferred away after being listed, and `listed` was never
  // cleared) - self-siring (isSireOwnedByCaller) is unaffected since it
  // doesn't depend on the listing at all.
  const isStaleListing = Boolean(
    sireLiveInfo && !isSireOwnedByCaller && sireLiveInfo.stale,
  );

  const canBreed = Boolean(
    address &&
    matron &&
    sireLiveInfo &&
    !sireLiveInfo.pending &&
    !sireLiveInfo.error &&
    !sameCollectionSameToken &&
    !matron.cooldown.onCooldown &&
    !sireLiveInfo.cooldown.onCooldown &&
    (isSireOwnedByCaller || sireLiveInfo.listed) &&
    (isSireOwnedByCaller || confirmed) &&
    sireLiveInfo.genesSet &&
    matron.genesReady &&
    !isStaleListing &&
    // The live birthFee/sameSexFeeMultiplier read must have resolved before
    // breeding is allowed - see the `feeConfig` state comment above.
    feeConfig !== null,
  );

  const pollForResult = useCallback(
    async (txHash: string): Promise<{ baby: BreedingRecord }> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(`/api/breed/${txHash}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.state === "ready") return { baby: data.baby };
      }
      throw new Error("Timed out waiting for the breeding transaction.");
    },
    [],
  );

  async function handleBreed() {
    if (
      !address ||
      !matron ||
      !sireLiveInfo ||
      !BREEDING_CONTROLLER_CONTRACT ||
      !feeConfig
    ) {
      return;
    }
    setError(null);
    try {
      // Fresh ownerOf-vs-lister re-check at the moment breeding is actually
      // initiated (not just re-trusting whatever sireLiveInfo was fetched
      // when the sire was selected, which could be stale by now if the tab
      // sat open) - if the sire isn't self-owned, re-pull live sire info and
      // bail before spending any approval gas if it's since gone stale.
      //
      // `effectiveSireInfo` (not the outer `sireLiveInfo` closure) is what
      // the fee math below is derived from: `setSireLiveInfo(fresh)` only
      // takes effect on the NEXT render, so re-reading the outer
      // `sireLiveInfo`/`feePreview` here would silently use pre-recheck
      // (possibly stale) price/sex data for the CHAN approval and
      // `maxTotalFee` even though a fresher read was just fetched.
      let effectiveSireInfo = sireLiveInfo;
      if (!isSireOwnedByCaller) {
        const fresh: SireLiveInfo = await fetch(
          `/api/sire/${sireLiveInfo.collection}/${sireLiveInfo.tokenId}`,
        ).then((res) => res.json());
        setSireLiveInfo(fresh);
        if (fresh.error) {
          throw new Error(fresh.error);
        }
        if (fresh.stale) {
          throw new Error(
            "This listing is stale - the owner has changed. Pick a different sire.",
          );
        }
        if (!fresh.listed) {
          throw new Error(
            "This sire is no longer listed for siring. Pick a different sire.",
          );
        }
        effectiveSireInfo = fresh;
      }

      const maxSiringFee = isSireOwnedByCaller
        ? BigInt(0)
        : BigInt(effectiveSireInfo.price || "0");
      // Recomputed from `effectiveSireInfo` (not the render-time
      // `feePreview` memo) for the same reason as `maxSiringFee` above -
      // this is what both the CHAN approval and `maxTotalFee` are derived
      // from, so it must reflect the just-fetched live price/sex, not a
      // possibly-stale render.
      const totalDebit = previewBreedFee({
        birthFee: feeConfig.birthFee,
        sameSexFeeMultiplier: feeConfig.sameSexFeeMultiplier,
        matronSex: matron.isMale,
        sireSex: effectiveSireInfo.isMale,
        sireCallerOwned: isSireOwnedByCaller,
        listedPrice: BigInt(effectiveSireInfo.price || "0"),
      }).totalCallerDebit;

      if (totalDebit > BigInt(0)) {
        setStage("approving");
        // Approve EXACTLY the previewed total debit, never an unlimited
        // allowance - `maxSiringFee` below is the real slippage bound
        // (BreedingController.breed() reverts SiringFeeTooHigh if the
        // sire's owner re-listed at a higher price meanwhile), but an
        // unlimited approval would still let a front-running relist (below
        // that revert bound) pull more than what was shown here if this
        // approval weren't also capped.
        const approveTx = buildApproveChanTx(
          BREEDING_CONTROLLER_CONTRACT,
          totalDebit,
        );
        await sendTransaction(address, approveTx);
      }

      setStage("breeding");
      // `maxTotalFee` bounds birthFeeOwed + siringFeeOwed together (the
      // BUG-4 fix - see lib/breedingController.ts's buildBreedTx doc
      // comment). Pass the exact previewed total, not a padded estimate:
      // the contract's ceiling check is inclusive (`== maxTotalFee`
      // succeeds), and previewBreedFee mirrors the contract's fee math
      // bit-for-bit off the same live birthFee/sameSexFeeMultiplier/price
      // reads that `totalDebit` (the CHAN approval amount above) already
      // used, so the two stay in lockstep.
      const tx = buildBreedTx(
        matron.collection,
        matron.tokenId,
        effectiveSireInfo.collection,
        effectiveSireInfo.tokenId,
        maxSiringFee,
        totalDebit,
      );
      const txHash = await sendTransaction(address, tx);

      setStage("waiting");
      setStage("generating");
      const result = await pollForResult(txHash);
      setBaby(result.baby);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Breeding failed.");
      setStage("error");
    }
  }

  // Sends the permissionless clearStaleListing(collection, tokenId) tx
  // (see lib/breedingController.ts's buildClearStaleListingTx) for the
  // currently-selected sire, then re-pulls /api/sire so the UI reflects
  // the now-cleared listing. Anyone can call this - clearing a stale
  // listing costs the caller gas but benefits every future browser of
  // /api/listings, not just this caller.
  async function handleClearStaleListing() {
    if (!address || !sireLiveInfo) return;
    setClearStaleError(null);
    setClearingStale(true);
    try {
      const tx = buildClearStaleListingTx(
        sireLiveInfo.collection,
        sireLiveInfo.tokenId,
      );
      await sendTransaction(address, tx);
      const fresh: SireLiveInfo = await fetch(
        `/api/sire/${sireLiveInfo.collection}/${sireLiveInfo.tokenId}`,
      ).then((res) => res.json());
      setSireLiveInfo(fresh);
    } catch (err) {
      setClearStaleError(
        err instanceof Error
          ? err.message
          : "Failed to clear the stale listing.",
      );
    } finally {
      setClearingStale(false);
    }
  }

  if (browsedInfo?.pending) {
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6">
        <ConfigPendingNotice what="The BreedingController contract" />
      </main>
    );
  }

  if (stage === "done" && baby) {
    const hype = baby.slots
      .map((s) => isMutantOrLegendary(s))
      .find((v): v is "legendary" | "mutant" => v !== null);
    return (
      <main className="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col gap-4 items-center text-center">
        <h1 className="hc-title text-2xl">Offspring hatched</h1>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={baby.imageUrl}
          alt="Offspring"
          className="w-64 h-64 object-cover rounded-lg hc-box"
        />
        <div className="flex flex-wrap gap-2 justify-center items-center">
          {hype === "legendary" && (
            <span className="hc-badge hc-badge-legendary text-sm">
              ✨ Legendary roll!
            </span>
          )}
          {hype === "mutant" && (
            <span className="hc-badge hc-badge-mutation text-sm">
              🧬 Mutation!
            </span>
          )}
          {baby.isTestTubeBaby && (
            <span className="hc-badge hc-badge-testtube text-sm">
              🧪 Test Tube Baby
            </span>
          )}
          <span className="hc-badge">
            {baby.babyIsMale ? "Male" : "Female"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 justify-center">
          {baby.slots.map((s) => {
            const kind = isMutantOrLegendary(s);
            return (
              <span
                key={s.slot}
                className={
                  kind === "legendary"
                    ? "hc-badge hc-badge-legendary"
                    : kind === "mutant"
                      ? "hc-badge hc-badge-mutation"
                      : "hc-badge"
                }
              >
                {s.slot}: {s.name}
              </span>
            );
          })}
        </div>
        <div className="flex gap-2">
          <Link href={`/baby/${baby.babyId}`} className="hc-button">
            View full offspring
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl w-full px-4 py-6 flex flex-col gap-4">
      {!address && (
        <button
          className="hc-button"
          onClick={() => connectWallet().catch(() => {})}
        >
          Connect Wallet to breed
        </button>
      )}

      {(stage === "waiting" || stage === "generating") && (
        <main className="flex flex-col items-center gap-3 py-6">
          <div className="hc-hatching">
            <span className="hc-hatching-egg">🥚</span>
            <span
              className="text-sm font-bold"
              style={{ color: "var(--hc-maroon)" }}
            >
              {stage === "waiting"
                ? "Breeding tx landing..."
                : "Hatching offspring..."}
            </span>
          </div>
        </main>
      )}

      {stage !== "waiting" && stage !== "generating" && (
        <>
          <section className="hc-box p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="hc-title text-lg">Sire</h2>
              <div className="flex gap-1">
                <button
                  className={
                    sireTab === "listed"
                      ? "hc-button text-xs"
                      : "hc-button-ghost hc-button text-xs"
                  }
                  onClick={() => setSireTab("listed")}
                >
                  Listed
                </button>
                <button
                  className={
                    sireTab === "mine"
                      ? "hc-button text-xs"
                      : "hc-button-ghost hc-button text-xs"
                  }
                  onClick={() => setSireTab("mine")}
                  disabled={!address}
                >
                  My tokens
                </button>
              </div>
            </div>

            {sireTab === "listed" && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {listedSireCandidates.map((l) => (
                  <button
                    key={`${l.collection}-${l.tokenId}`}
                    className="hc-card"
                    style={
                      sireSelection?.collection === l.collection &&
                      sireSelection?.tokenId === l.tokenId
                        ? { borderColor: "var(--hc-header-to)", borderWidth: 2 }
                        : undefined
                    }
                    onClick={() => {
                      setSireSelection({
                        collection: l.collection,
                        tokenId: l.tokenId,
                      });
                      setConfirmed(false);
                    }}
                  >
                    {l.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={l.image}
                        alt={l.name}
                        className="w-full aspect-square object-cover"
                      />
                    ) : (
                      <div
                        className="w-full aspect-square"
                        style={{ background: "var(--hc-box-alt)" }}
                      />
                    )}
                    <span className="text-xs p-1 truncate">{l.name}</span>
                    <span className="hc-badge hc-badge-chan text-[0.6rem] mx-1 mb-1">
                      {formatUnits(l.price, 18)} CHAN
                    </span>
                  </button>
                ))}
                {listedSireCandidates.length === 0 && (
                  <p
                    className="text-sm col-span-full"
                    style={{ color: "var(--hc-muted)" }}
                  >
                    No sires currently listed.
                  </p>
                )}
              </div>
            )}

            {sireTab === "mine" && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {ownedTokens.map((t) => (
                  <button
                    key={`${t.collection}-${t.tokenId}`}
                    className="hc-card"
                    style={
                      sireSelection?.collection === t.collection &&
                      sireSelection?.tokenId === t.tokenId
                        ? { borderColor: "var(--hc-header-to)", borderWidth: 2 }
                        : undefined
                    }
                    onClick={() => {
                      setSireSelection({
                        collection: t.collection,
                        tokenId: t.tokenId,
                      });
                      setConfirmed(false);
                    }}
                  >
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
                    <span className="text-xs p-1 truncate">{t.name}</span>
                    <span className="hc-badge text-[0.6rem] mx-1 mb-1">
                      {cooldownLabel(t.cooldown)}
                    </span>
                  </button>
                ))}
                {ownedPending && (
                  <p
                    className="text-sm col-span-full"
                    style={{ color: "var(--hc-muted)" }}
                  >
                    Loading your tokens...
                  </p>
                )}
              </div>
            )}

            {sireLoading && (
              <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
                Loading sire...
              </p>
            )}
            {sireLiveInfo && !sireLoading && !sireLiveInfo.error && (
              <div
                className="hc-box p-3"
                style={{ background: "var(--hc-box-alt)" }}
              >
                <p className="text-sm font-bold">
                  {sireLiveInfo.name} (
                  {collectionLabel(sireLiveInfo.collection)}) -{" "}
                  {isSireOwnedByCaller
                    ? "you own this one, free to sire"
                    : isStaleListing
                      ? "stale listing - owner changed"
                      : sireLiveInfo.listed
                        ? `${formatUnits(sireLiveInfo.price, 18)} CHAN`
                        : "not listed for siring"}
                </p>
                <p
                  className="text-xs mt-1"
                  style={{ color: "var(--hc-muted)" }}
                >
                  {cooldownLabel(sireLiveInfo.cooldown)}
                  {" · "}
                  {sireLiveInfo.isMale ? "Male" : "Female"}
                </p>
                {!sireLiveInfo.genesSet && (
                  <p
                    className="text-xs mt-1"
                    style={{ color: "var(--hc-danger)" }}
                  >
                    This token&apos;s genes haven&apos;t been synced yet -
                    breeding will revert until they are.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="hc-box p-4 flex flex-col gap-3">
            <h2 className="hc-title text-lg">Matron</h2>
            {!address && (
              <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
                Connect your wallet to pick a matron from your own tokens.
              </p>
            )}
            {address && ownedPending && (
              <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
                Loading your tokens...
              </p>
            )}
            {address && !ownedPending && ownedTokens.length === 0 && (
              <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
                You don&apos;t own any breedable tokens yet - you need one
                (HOODCHAN, Girlfriend, or Baby) to breed as the matron.
              </p>
            )}
            {address && ownedTokens.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {ownedTokens.map((t) => (
                  <button
                    key={`${t.collection}-${t.tokenId}`}
                    className="hc-card"
                    style={
                      matron?.collection === t.collection &&
                      matron?.tokenId === t.tokenId
                        ? { borderColor: "var(--hc-header-to)", borderWidth: 2 }
                        : undefined
                    }
                    onClick={() => {
                      setMatron(t);
                      setConfirmed(false);
                    }}
                  >
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
                    <span className="text-xs p-1 truncate">{t.name}</span>
                    <span className="hc-badge text-[0.6rem] mx-1 mb-1">
                      {cooldownLabel(t.cooldown)}
                    </span>
                    {!t.genesReady && (
                      <span
                        className="text-[0.6rem] mx-1 mb-1"
                        style={{ color: "var(--hc-danger)" }}
                      >
                        genes not synced yet
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>

          {sameCollectionSameToken && (
            <div className="hc-error-box">
              A token can&apos;t breed with itself - pick a different matron or
              sire.
            </div>
          )}

          {isStaleListing && (
            <div className="hc-error-box flex flex-col gap-2 items-start">
              <p>
                This listing is stale - the owner has changed since it was
                listed for siring. Pick a different sire, or ask the new owner
                to re-list.
              </p>
              {address && (
                <button
                  type="button"
                  className="hc-button hc-button-ghost text-sm"
                  disabled={clearingStale}
                  onClick={handleClearStaleListing}
                >
                  {clearingStale
                    ? "Clearing listing..."
                    : "Clear this stale listing (anyone can do this)"}
                </button>
              )}
              {clearStaleError && (
                <p className="text-sm" style={{ color: "var(--hc-danger)" }}>
                  {clearStaleError}
                </p>
              )}
            </div>
          )}

          {feePreview && matron && sireLiveInfo && !sameCollectionSameToken && (
            <div
              className="hc-box p-3 flex flex-col gap-2"
              style={{ background: "var(--hc-box-alt)" }}
            >
              {matron.isMale === sireLiveInfo.isMale && (
                <p
                  className="text-sm font-bold"
                  style={{ color: "var(--hc-legendary)" }}
                >
                  🧪 Same-sex pairing - Test Tube Baby pricing applies (the
                  birth fee is multiplied).
                </p>
              )}
              <p className="text-sm">
                You will pay up to{" "}
                <strong>
                  {formatUnits(feePreview.totalCallerDebit, 18)} CHAN
                </strong>{" "}
                total (birth fee
                {isSireOwnedByCaller ? "" : " + siring fee + 8% protocol fee"}
                ). If the sire&apos;s owner raises the price before your tx
                lands, the transaction reverts instead of charging you more.
              </p>
              {feeConfigLoading && !feeConfig && (
                <p className="text-xs" style={{ color: "var(--hc-muted)" }}>
                  Confirming live birth fee from chain - the amount above is an
                  estimate until this resolves, and breeding is disabled until
                  it does.
                </p>
              )}
              {!feeConfigLoading && feeConfigError && (
                <p className="text-xs" style={{ color: "var(--hc-danger)" }}>
                  Failed to load the live birth fee ({feeConfigError}) -
                  breeding is disabled until this succeeds.
                </p>
              )}
              {!isSireOwnedByCaller && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={!feeConfig}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I confirm this price
                </label>
              )}
            </div>
          )}

          <button
            className="hc-button"
            disabled={
              !canBreed || stage === "approving" || stage === "breeding"
            }
            onClick={handleBreed}
          >
            {stage === "approving" && "Approving CHAN..."}
            {stage === "breeding" && "Sending breed tx..."}
            {(stage === "idle" || stage === "error") && "Breed"}
          </button>

          {stage === "error" && error && (
            <div className="hc-error-box">{error}</div>
          )}
        </>
      )}
    </main>
  );
}
