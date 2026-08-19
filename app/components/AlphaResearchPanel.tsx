"use client";

// Alpha Bot trigger + display for the wallet page. Reuses the active
// posting persona (lib/usePersona.ts) as proof of ownership for the
// research POST - the exact same signed claim already used to post as
// this anon, not a separate signing flow (see app/api/alpha/research/
// route.ts's own comment on why that's the right amount of auth here).
// Anyone can view a wallet page; only the anon's current owner (the one
// actually signed in as it) sees the trigger button.
import { useState } from "react";
import { useActivePersona } from "@/lib/usePersona";
import type { AlphaBotEntry } from "@/lib/alphaBotStore";
import { MIN_HOLD_WEEKS_FOR_ALPHA_BOT } from "@/lib/alphaBotConfig";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function timeAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "less than an hour ago";
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function hoursRemaining(generatedAtIso: string, now: number): number {
  const elapsedMs = now - Date.parse(generatedAtIso);
  return Math.max(1, Math.ceil((COOLDOWN_MS - elapsedMs) / (60 * 60 * 1000)));
}

export function AlphaResearchPanel({
  tokenId,
  initialEntry,
  hodlerWeeks,
}: {
  tokenId: string;
  initialEntry: AlphaBotEntry | null;
  // How long the CURRENT owner has held this specific anon (lib/
  // collectionSnapshot.ts's weeksHeld, same source the leveling system's
  // Hodler XP already uses) - resets to 0 on transfer, so a same-day
  // buy-then-claim can't qualify. Server-computed on the wallet page and
  // passed down rather than recomputed here, and re-enforced server-side
  // in app/api/alpha/research/route.ts regardless (this prop only decides
  // what the UI shows before a click, it isn't the real gate).
  hodlerWeeks: number;
}) {
  const { persona } = useActivePersona();
  const [entry, setEntry] = useState(initialEntry);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Captured once at mount (a lazy initializer only runs that one time,
  // so this doesn't trip the "no impure calls during render" rule the way
  // calling Date.now() directly in the component body would) - this panel
  // has no live-ticking clock requirement, just a 24h cooldown check, so a
  // value that's accurate as of first paint is fine.
  const [now] = useState(() => Date.now());

  const isOwner = persona?.tokenId === tokenId;
  const qualifies = hodlerWeeks >= MIN_HOLD_WEEKS_FOR_ALPHA_BOT;
  const isFresh = entry && now - Date.parse(entry.generatedAt) < COOLDOWN_MS;

  const handleResearch = async () => {
    if (!persona) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/alpha/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tokenId: persona.tokenId,
          address: persona.address,
          signature: persona.signature,
          issuedAt: persona.issuedAt,
          ...(persona.batchTokenIds
            ? { batchTokenIds: persona.batchTokenIds }
            : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `Research failed (${res.status}).`,
        );
      }
      setEntry(body.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Research failed.");
    } finally {
      setLoading(false);
    }
  };

  if (!entry && !isOwner) return null;

  return (
    <div className="hc-box p-4 w-full">
      <div className="hc-thread-meta text-xs mb-2">Alpha Bot research</div>

      {entry ? (
        <>
          <p className="hc-thread-meta text-xs mb-2">
            Last researched {timeAgo(entry.generatedAt, now)} · real Nansen
            data, narrated by AI - not a fake shitpost.
          </p>
          {entry.desks.length > 0 ? (
            <div className="flex flex-col gap-3">
              {entry.desks.map((desk) => (
                <div key={desk.name}>
                  <div className="hc-thread-subject text-xs mb-1">
                    {desk.name}
                  </div>
                  <ul className="flex flex-col gap-1 text-sm list-disc pl-5">
                    {desk.bullets.map((bullet, i) => (
                      <li key={i}>{bullet}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="hc-thread-meta text-sm">Nothing notable found.</p>
          )}
          {entry.totalValueUsd !== null && (
            <p className="hc-thread-meta text-xs mt-2">
              Total tracked value: $
              {entry.totalValueUsd.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
            </p>
          )}
        </>
      ) : (
        <p className="hc-thread-meta text-sm mb-2">
          Not researched yet - real on-chain data from Nansen, grounded, not
          invented.
        </p>
      )}

      {isOwner && !qualifies && (
        <p className="hc-thread-meta text-xs mt-2">
          🔒 For long-term holders only - hold this anon for{" "}
          {MIN_HOLD_WEEKS_FOR_ALPHA_BOT} weeks to unlock Alpha Bot (currently{" "}
          {hodlerWeeks}/{MIN_HOLD_WEEKS_FOR_ALPHA_BOT}).
        </p>
      )}
      {isOwner && qualifies && (!entry || !isFresh) && (
        <button
          onClick={handleResearch}
          disabled={loading}
          className="hc-button-ghost hc-button text-xs mt-3"
        >
          {loading
            ? "Researching..."
            : entry
              ? "Refresh research"
              : "Run Nansen research"}
        </button>
      )}
      {isOwner && qualifies && entry && isFresh && (
        <p className="hc-thread-meta text-xs mt-2">
          Can refresh again in about {hoursRemaining(entry.generatedAt, now)}h.
        </p>
      )}
      {error && (
        <p className="text-xs mt-2" style={{ color: "#a12b2b" }}>
          {error}
        </p>
      )}
    </div>
  );
}
