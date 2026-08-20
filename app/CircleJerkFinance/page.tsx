"use client";

// CircleJerkFinance - the community asset registry. Any anon that holds a
// nested HOODCHAN and has posted at least once can list their own
// project's NFT collection or token; core members can sponsor a listing
// for anyone who hasn't hit that bar yet. Every listed contract is queryable
// live via /api/v1/registry/holdings/{address} - the actual "automated
// mutual whitelisting" primitive other community projects integrate
// against, so nobody has to hand-maintain a copy of every other project's
// holder list.
//
// Yes, this is an unironic token-curated registry (TCR) - the exact
// primitive District0x built its whole early thesis on.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { RegistryEntry } from "@/lib/registryStore";
import { SubmitEntryForm } from "./SubmitEntryForm";

export default function CircleJerkFinancePage() {
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/registry");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => load());
  }, [load]);

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-6 px-6 py-8">
        <Link href="/" className="hc-link text-sm">
          ‹ back to h00dchan
        </Link>

        <div>
          <h1 className="hc-title text-2xl">CircleJerkFinance</h1>
          <p className="hc-thread-meta text-sm mt-1">
            The community-curated registry of community-built projects. List
            your own NFT collection or token so other holders can find it - and
            so other projects can pull the list to auto-whitelist each other.
            Bar to list: hold a nested HOODCHAN in your anon&apos;s wallet and
            have posted at least once (or get a core member to vouch for you).
          </p>
          <p className="hc-thread-meta text-xs mt-2">
            Integrate:{" "}
            <code className="hc-thread-meta">
              GET /api/v1/registry/holdings/{"{"}address{"}"}
            </code>{" "}
            returns every listed project a given wallet currently holds.
          </p>
        </div>

        <SubmitEntryForm
          onSubmitted={(entry) =>
            setEntries((prev) => [entry, ...(prev ?? [])])
          }
        />

        {error && (
          <p className="text-sm" style={{ color: "var(--hc-danger)" }}>
            {error}
          </p>
        )}

        {entries === null && !error && (
          <p className="hc-thread-meta text-center">Loading...</p>
        )}
        {entries !== null && entries.length === 0 && (
          <p className="hc-thread-meta text-center">
            Nothing listed yet - be the first.
          </p>
        )}

        <div className="flex flex-col gap-3">
          {entries?.map((entry) => (
            <div key={entry.id} className="hc-box p-4 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="hc-thread-subject text-sm">{entry.name}</span>
                <span className="hc-thread-meta text-xs">
                  {entry.kind === "nft" ? "NFT collection" : "ERC-20 token"}
                </span>
                {entry.sponsored && (
                  <span className="hc-thread-meta text-xs">core-vouched</span>
                )}
              </div>
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hc-link text-sm break-all"
              >
                {entry.url}
              </a>
              {entry.description && (
                <p className="text-sm">{entry.description}</p>
              )}
              <div className="hc-thread-meta text-xs break-all">
                {entry.contractAddress}
              </div>
              <div className="hc-thread-meta text-xs">
                listed by Anon #{entry.submitterTokenId}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
