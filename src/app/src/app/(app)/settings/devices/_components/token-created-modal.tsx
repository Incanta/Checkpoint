"use client";

import { useEffect, useState } from "react";
import { Button } from "~/app/_components/ui";

interface TokenCreatedModalProps {
  token: string;
  onClose: () => void;
}

/**
 * Shown after a codeless ("copyable") API token is created. The raw token is
 * only available here, once, so we surface it with a copy-to-clipboard button
 * and a warning that it won't be shown again.
 */
export function TokenCreatedModal({ token, onClose }: TokenCreatedModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — the token stays
      // visible for manual selection, so no further action is needed.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-lg font-semibold text-[var(--color-text-primary)]">
          API Token Created
        </h3>
        <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
          Copy this token now. For your security it won&apos;t be shown again.
        </p>

        <div className="mb-4 flex items-stretch gap-2">
          <code className="flex-1 overflow-x-auto rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 font-mono text-sm break-all text-[var(--color-text-primary)]">
            {token}
          </code>
          <Button
            type="button"
            variant="secondary"
            onClick={handleCopy}
            className="shrink-0"
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>

        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
