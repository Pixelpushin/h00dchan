"use client";

// Submission form for the CircleJerkFinance registry - same "must be
// posting as a claimed anon" gate and postJsonAsPersona flow as
// NewThreadForm/ReplyForm. The eligibility bar itself (>=1 nested
// HOODCHAN + >=1 human post, or a core-member sponsor) is enforced
// server-side (lib/registryEligibility.ts) - this form doesn't duplicate
// that check client-side, it just surfaces whatever reason the server
// gives back on rejection.
import Link from "next/link";
import { useState } from "react";
import { useActivePersona } from "@/lib/usePersona";
import { useWalletAddress } from "@/lib/useWalletAddress";
import { postJsonAsPersona } from "@/lib/postAsPersona";
import type { RegistryEntry, RegistryKind } from "@/lib/registryStore";

export function SubmitEntryForm({
  onSubmitted,
}: {
  onSubmitted: (entry: RegistryEntry) => void;
}) {
  const { persona, reauthorize } = useActivePersona();
  const address = useWalletAddress();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<RegistryKind>("nft");
  const [name, setName] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!persona) {
    return (
      <div className="hc-box p-4 text-sm">
        {address ? (
          <>
            Your wallet&apos;s connected, but you haven&apos;t picked which anon
            to post as in this tab yet.{" "}
            <Link href="/" className="hc-link">
              Pick one on the home page
            </Link>{" "}
            to submit a project.
          </>
        ) : (
          <>
            <Link href="/" className="hc-link">
              Connect your wallet and activate an anon
            </Link>{" "}
            to submit a project.
          </>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="hc-button">
        Submit a project
      </button>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !contractAddress.trim() || !url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await postJsonAsPersona<{ entry: RegistryEntry }>(
        "/api/registry",
        {
          kind,
          name: name.trim(),
          contractAddress: contractAddress.trim(),
          url: url.trim(),
          description: description.trim(),
        },
        persona,
        reauthorize,
      );
      setName("");
      setContractAddress("");
      setUrl("");
      setDescription("");
      setOpen(false);
      onSubmitted(result.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="hc-box p-4 flex flex-col gap-2">
      <div className="hc-post-tokenid text-sm">
        Submitting as Anon #{persona.tokenId}
      </div>
      <div className="flex gap-2">
        <label className="flex items-center gap-1 text-sm">
          <input
            type="radio"
            checked={kind === "nft"}
            onChange={() => setKind("nft")}
            disabled={submitting}
          />
          NFT collection
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="radio"
            checked={kind === "token"}
            onChange={() => setKind("token")}
            disabled={submitting}
          />
          ERC-20 token
        </label>
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        maxLength={60}
        className="hc-form-input"
        disabled={submitting}
      />
      <input
        value={contractAddress}
        onChange={(e) => setContractAddress(e.target.value)}
        placeholder="Contract address (0x...)"
        maxLength={42}
        className="hc-form-input"
        disabled={submitting}
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Project URL (site, OpenSea, etc)"
        maxLength={300}
        className="hc-form-input"
        disabled={submitting}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="One-line description (optional)"
        rows={2}
        maxLength={280}
        className="hc-form-input"
        disabled={submitting}
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="hc-button">
          {submitting ? "Submitting..." : "Submit"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={submitting}
          className="hc-button-ghost hc-button"
        >
          Cancel
        </button>
        {error && (
          <span className="text-sm" style={{ color: "var(--hc-danger)" }}>
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
