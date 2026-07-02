"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export function SetupForm() {
  useDocumentTitle("Initial Setup · Checkpoint VCS");
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [shareMetrics, setShareMetrics] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const acceptEula = api.setup.acceptEula.useMutation({
    onSuccess: () => {
      router.push("/");
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleAccept = () => {
    setError(null);
    acceptEula.mutate({ telemetryEnabled: shareMetrics });
  };

  return (
    <div className="w-full max-w-lg space-y-6 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-8">
      <div>
        <h1 className="text-center text-2xl font-semibold text-[var(--color-text-primary)]">
          Welcome to Checkpoint
        </h1>
        <p className="mt-2 text-center text-sm text-[var(--color-text-secondary)]">
          Before continuing, please review and accept the following agreements.
        </p>
      </div>

      <div className="space-y-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-4">
        <p className="text-sm text-[var(--color-text-primary)]">
          Please review the following documents:
        </p>
        <ul className="list-inside list-disc space-y-2 text-sm">
          <li>
            <a
              href="https://checkpointvcs.com/eula"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline"
            >
              End User License Agreement (EULA)
            </a>
          </li>
          <li>
            <a
              href="https://checkpointvcs.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline"
            >
              Privacy Policy
            </a>
          </li>
        </ul>
      </div>

      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="h-4 w-4 rounded border-[var(--color-border-default)] bg-[var(--color-bg-primary)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
        />
        <span className="text-sm text-[var(--color-text-primary)]">
          I have read and agree to the EULA and Privacy Policy
        </span>
      </label>

      <div className="space-y-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={shareMetrics}
            onChange={(e) => setShareMetrics(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-[var(--color-border-default)] bg-[var(--color-bg-primary)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
          />
          <span className="text-sm text-[var(--color-text-primary)]">
            Share anonymous usage metrics
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
              Once a week we send aggregate counts (organizations, repositories,
              and users) plus a random instance id to Incanta. No names, content,
              or personal data are included. You can leave this unchecked to opt
              out.
            </span>
          </span>
        </label>
      </div>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3">
          <p className="text-sm text-[var(--color-danger)]">{error}</p>
        </div>
      )}

      <button
        type="button"
        onClick={handleAccept}
        disabled={!agreed || acceptEula.isPending}
        className="flex w-full justify-center rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {acceptEula.isPending ? "Accepting…" : "Accept & Continue"}
      </button>
    </div>
  );
}
