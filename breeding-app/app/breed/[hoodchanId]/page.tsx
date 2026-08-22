"use client";

// Two-step commit/reveal breeding flow - see
// contracts/src/BreedingController.sol's SEED-FAIRNESS MITIGATION note for
// why breeding isn't a single tx: commitBreed() escrows payment (bounded by
// a caller-supplied max - BUG 2's slippage guard) and locks both parents;
// revealBreed() derives the genome from blockhash(commitBlock), a value
// that doesn't exist yet at commit time, then mints. The UI drives both
// steps automatically (auto-calls revealBreed once eligible, ~1 block after
// commitBreed lands) and offers a resume path for an abandoned commit
// (found via localStorage - the state itself always lives on-chain in
// `commits(commitId)`, this is just how the UI re-finds a commitId after a
// reload) plus a cancel/refund path once the 256-block reveal window has
// expired.
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
import {
  PayMethod,
  buildCommitBreedTx,
  buildRevealBreedTx,
  buildCancelExpiredCommitTx,
  readCommit,
  type CommitInfo,
} from "@/lib/breedingController";
import { rpcCall } from "@/lib/chain";
import type { TokenMetadata } from "@/lib/chain";

interface SireInfo {
  pending?: boolean;
  hoodchanId: string;
  owner: string;
  chanPrice: string;
  ethPrice: string;
  listed: boolean;
  genesSet: boolean;
  ethEligible: boolean;
  fatherLocked: boolean;
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
  | "committing"
  | "waiting-commit"
  | "revealing"
  | "waiting-reveal"
  | "generating"
  | "done"
  | "error";

function storageKey(address: string, hoodchanId: string): string {
  return `hoodchan-breeding-commit:${address.toLowerCase()}:${hoodchanId}`;
}

interface StoredCommit {
  commitId: string;
  motherId: string;
  txHash: string;
}

async function currentBlockNumber(): Promise<bigint> {
  const hex = await rpcCall<string>("eth_blockNumber", []);
  return BigInt(hex);
}

const REVEAL_WINDOW_BLOCKS = 256n;

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
  const [motherId, setMotherId] = useState<string | null>(null);
  const [payWith, setPayWith] = useState<"chan" | "eth">("chan");
  const [confirmed, setConfirmed] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [baby, setBaby] = useState<BreedingRecord | null>(null);
  const [resumable, setResumable] = useState<{
    commit: StoredCommit;
    info: CommitInfo;
    expired: boolean;
  } | null>(null);

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

  // Resume path: check localStorage for an abandoned commit tied to this
  // wallet + this sire. The commit's real state always lives on-chain
  // (commits(commitId)) - localStorage is only how the UI re-finds the
  // commitId to look that up after a reload; a stale/bogus localStorage
  // entry just fails the readCommit lookup harmlessly.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const raw = localStorage.getItem(storageKey(address, hoodchanId));
    if (!raw) return;
    let stored: StoredCommit;
    try {
      stored = JSON.parse(raw);
    } catch {
      localStorage.removeItem(storageKey(address, hoodchanId));
      return;
    }
    Promise.all([readCommit(stored.commitId), currentBlockNumber()])
      .then(([info, blockNow]) => {
        if (cancelled) return;
        if (info.resolved) {
          localStorage.removeItem(storageKey(address, hoodchanId));
          return;
        }
        const expired = blockNow - info.commitBlock > REVEAL_WINDOW_BLOCKS;
        setResumable({ commit: stored, info, expired });
      })
      .catch(() => {
        // commitId no longer resolvable (e.g. wrong network) - drop it.
        localStorage.removeItem(storageKey(address, hoodchanId));
      });
    return () => {
      cancelled = true;
    };
  }, [address, hoodchanId]);

  const isFree = Boolean(
    sire && address && sire.owner?.toLowerCase() === address.toLowerCase(),
  );

  const currentPrice =
    sire && payWith === "eth"
      ? BigInt(sire.ethPrice)
      : sire
        ? BigInt(sire.chanPrice)
        : BigInt(0);

  const pollForResult = useCallback(
    async (
      txHash: string,
    ): Promise<
      | { state: "ready"; baby: BreedingRecord }
      | { state: "committed"; commitId: string }
    > => {
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(`/api/breed/${txHash}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.state === "ready") return { state: "ready", baby: data.baby };
        if (data.state === "committed") {
          return { state: "committed", commitId: data.commitId };
        }
        // "pending" - keep polling.
      }
      throw new Error("Timed out waiting for the breeding transaction.");
    },
    [],
  );

  const revealOnceEligible = useCallback(
    async (commitId: string): Promise<void> => {
      if (!address) return;
      setStage("revealing");
      // revealBreed requires block.number > commitBlock - the commit tx is
      // already mined by the time we have a commitId, but the VERY next
      // block might not have landed yet on a fast poll. Retry on
      // RevealTooEarly rather than requiring a second manual click.
      let revealTxHash: string | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const tx = buildRevealBreedTx(commitId);
          revealTxHash = await sendTransaction(address, tx);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("RevealTooEarly") && attempt < 19) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw err;
        }
      }
      if (!revealTxHash) throw new Error("Failed to send revealBreed.");

      setStage("waiting-reveal");
      const result = await pollForResult(revealTxHash);
      if (result.state !== "ready") {
        throw new Error(
          "Reveal transaction did not resolve to a finished offspring.",
        );
      }
      localStorage.removeItem(storageKey(address, hoodchanId));
      setBaby(result.baby);
      setStage("done");
    },
    [address, hoodchanId, pollForResult],
  );

  async function handleResume() {
    if (!resumable || !address) return;
    setError(null);
    try {
      await revealOnceEligible(
        resumable.info.commitId ?? resumable.commit.commitId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reveal failed.");
      setStage("error");
    }
  }

  async function handleCancelExpired() {
    if (!resumable || !address) return;
    setError(null);
    try {
      const tx = buildCancelExpiredCommitTx(resumable.commit.commitId);
      const txHash = await sendTransaction(address, tx);
      await fetch(`/api/breed/${txHash}`).catch(() => {});
      localStorage.removeItem(storageKey(address, hoodchanId));
      setResumable(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed.");
    }
  }

  async function handleBreed() {
    if (!sire || !address || !motherId) return;
    if (!isFree && !confirmed) {
      setError("Confirm the price above before breeding.");
      return;
    }
    setError(null);
    try {
      const method = payWith === "eth" ? PayMethod.ETH : PayMethod.CHAN;
      // The EXACT price shown/confirmed above is what gets passed as the
      // max bound - BUG 2's slippage guard. commitBreed reverts with
      // PriceExceedsMax if the CURRENT listed price is now higher than
      // this, rather than silently charging more.
      const maxChanPrice = isFree
        ? BigInt(0)
        : method === PayMethod.CHAN
          ? BigInt(sire.chanPrice)
          : BigInt(0);
      const maxEthPrice = isFree
        ? BigInt(0)
        : method === PayMethod.ETH
          ? BigInt(sire.ethPrice)
          : BigInt(0);
      const valueWei =
        !isFree && method === PayMethod.ETH ? BigInt(sire.ethPrice) : BigInt(0);

      if (!isFree && method === PayMethod.CHAN && maxChanPrice > BigInt(0)) {
        setStage("approving");
        // Approve EXACTLY the confirmed price, never an unlimited
        // allowance - if a father-owner front-runs with a higher
        // setSiringPrice between approve and commitBreed, commitBreed's
        // own maxChanPrice bound reverts the commit before any transfer,
        // and even in the (impossible, since it reverts first) worst case
        // this approval could never let more than the confirmed price be
        // pulled.
        const approveTx = buildApproveChanTx(
          process.env.NEXT_PUBLIC_BREEDING_CONTROLLER_CONTRACT as string,
          maxChanPrice,
        );
        await sendTransaction(address, approveTx);
      }

      setStage("committing");
      const commitTx = buildCommitBreedTx(
        hoodchanId,
        motherId,
        maxChanPrice,
        maxEthPrice,
        method,
        valueWei,
      );
      const commitTxHash = await sendTransaction(address, commitTx);

      setStage("waiting-commit");
      const result = await pollForResult(commitTxHash);
      if (result.state !== "committed") {
        throw new Error("Commit transaction did not resolve to a commitId.");
      }

      localStorage.setItem(
        storageKey(address, hoodchanId),
        JSON.stringify({
          commitId: result.commitId,
          motherId,
          txHash: commitTxHash,
        } satisfies StoredCommit),
      );

      await revealOnceEligible(result.commitId);
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
              {formatUnits(sire.chanPrice, 18)} CHAN
            </span>
            {sire.ethEligible && (
              <span className="hc-badge hc-badge-eth">
                {formatUnits(sire.ethPrice, 18)} ETH
              </span>
            )}
          </div>
          {!sire.genesSet && (
            <p className="text-xs mt-1" style={{ color: "var(--hc-danger)" }}>
              This anon&apos;s genes haven&apos;t been synced yet - breeding
              will revert until they are.
            </p>
          )}
        </div>
      </div>

      {resumable && (
        <div className="hc-box p-4 flex flex-col gap-2">
          <p className="text-sm font-bold">
            You have an unfinished commit (#{resumable.commit.commitId}) for
            this sire.
          </p>
          {resumable.expired ? (
            <>
              <p className="text-sm" style={{ color: "var(--hc-muted)" }}>
                The reveal window has closed. Cancel to refund your escrowed
                payment and unlock both tokens.
              </p>
              <button className="hc-button" onClick={handleCancelExpired}>
                Cancel &amp; refund
              </button>
            </>
          ) : (
            <button className="hc-button" onClick={handleResume}>
              Resume: reveal now
            </button>
          )}
        </div>
      )}

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

      {address && girlfriends.length > 0 && !resumable && (
        <div className="hc-box p-4 flex flex-col gap-3">
          <label className="text-sm font-bold">Pick a mother</label>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {girlfriends.map((g) => (
              <button
                key={g.tokenId}
                onClick={() => {
                  setMotherId(g.tokenId);
                  setConfirmed(false);
                }}
                className="hc-card"
                style={
                  motherId === g.tokenId
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
              You own this sire and the mother - breeding is free.
            </p>
          )}

          {!isFree && sire.ethEligible && (
            <div className="flex gap-2">
              <label className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  checked={payWith === "chan"}
                  onChange={() => {
                    setPayWith("chan");
                    setConfirmed(false);
                  }}
                />
                Pay in CHAN
              </label>
              <label className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  checked={payWith === "eth"}
                  onChange={() => {
                    setPayWith("eth");
                    setConfirmed(false);
                  }}
                />
                Pay in ETH
              </label>
            </div>
          )}

          {!isFree && motherId && (
            <div
              className="hc-box p-3 flex flex-col gap-2"
              style={{ background: "var(--hc-box-alt)" }}
            >
              <p className="text-sm">
                You will pay exactly{" "}
                <strong>
                  {formatUnits(currentPrice, 18)}{" "}
                  {payWith === "eth" ? "ETH" : "CHAN"}
                </strong>
                . If the sire&apos;s owner raises the price before your commit
                lands, the transaction reverts instead of charging you more.
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
              !motherId ||
              (!isFree && !confirmed) ||
              stage === "approving" ||
              stage === "committing" ||
              stage === "waiting-commit" ||
              stage === "revealing" ||
              stage === "waiting-reveal" ||
              stage === "generating"
            }
            onClick={handleBreed}
          >
            {stage === "approving" && "Approving CHAN..."}
            {stage === "committing" && "Sending commit tx..."}
            {stage === "waiting-commit" && "Waiting for commit to land..."}
            {stage === "revealing" && "Sending reveal tx..."}
            {stage === "waiting-reveal" && "Waiting for reveal to land..."}
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
