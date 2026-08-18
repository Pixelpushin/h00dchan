"use client";

// Small icon button next to an address - one click, no select-and-drag
// needed to copy a 42-char hex string before pasting it somewhere to
// send to. Briefly swaps to a checkmark as the only feedback (no toast/
// alert), same low-key confirmation pattern as everything else in this
// app's UI.
import { useState } from "react";
import { CopyIcon, CheckIcon } from "@/app/components/Icons";

export function CopyButton({
  text,
  label = "copy address",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail (permissions, insecure context) - nothing
      // useful to do beyond just not showing the "copied" confirmation.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="hc-copy-btn"
      aria-label={label}
      title={label}
    >
      {copied ? (
        <CheckIcon className="hc-btn-icon" />
      ) : (
        <CopyIcon className="hc-btn-icon" />
      )}
    </button>
  );
}
