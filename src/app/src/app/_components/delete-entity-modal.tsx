"use client";

import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "~/app/_components/ui";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type Step = "stats" | "warning" | "confirm";

interface BaseProps {
  orgName: string;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
  /** Optional extra warning content rendered on the warning step. */
  extraWarning?: React.ReactNode;
}

type DeleteEntityModalProps = BaseProps &
  (
    | { kind: "org"; orgId: string; repoName?: undefined; repoId?: undefined }
    | { kind: "repo"; repoName: string; repoId: string; orgId?: undefined }
  );

export function DeleteEntityModal(props: DeleteEntityModalProps) {
  const { kind, orgName, onClose, onConfirm, isPending, extraWarning } = props;

  const [step, setStep] = useState<Step>("stats");
  const [confirmInput, setConfirmInput] = useState("");

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const displayName =
    kind === "repo" ? `${orgName}/${props.repoName}` : orgName;
  // Case-sensitive confirmation string the user must type to enable deletion.
  const confirmTarget = displayName;

  const entityWord = kind === "org" ? "organization" : "repository";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
            Delete {displayName}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        {step === "stats" && (
          <StatsStep
            {...props}
            onNext={() => setStep("warning")}
            entityWord={entityWord}
          />
        )}

        {step === "warning" && (
          <div className="space-y-4">
            {kind === "org" && <OrgRepoList orgId={props.orgId} />}

            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="flex items-start gap-2">
                <svg
                  className="mt-0.5 shrink-0 text-amber-500"
                  width="18"
                  height="18"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
                </svg>
                <p className="text-sm font-semibold text-amber-400">
                  Unexpected bad things will happen if you don&rsquo;t read
                  this!
                </p>
              </div>
            </div>

            <p className="text-sm text-[var(--color-text-secondary)]">
              {kind === "org" ? (
                <>
                  This will permanently delete the{" "}
                  <strong className="text-[var(--color-text-primary)]">
                    {orgName}
                  </strong>{" "}
                  organization and all of its repositories, stored data, issues,
                  pull requests, and comments.
                </>
              ) : (
                <>
                  This will permanently delete the{" "}
                  <strong className="text-[var(--color-text-primary)]">
                    {displayName}
                  </strong>{" "}
                  repository, stored data, issues, pull requests, and comments.
                </>
              )}
            </p>

            {extraWarning}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep("stats")}>
                Back
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setStep("confirm")}
              >
                I have read and understand these effects
              </Button>
            </div>
          </div>
        )}

        {step === "confirm" && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              To confirm, type{" "}
              <strong className="text-[var(--color-text-primary)]">
                &quot;{confirmTarget}&quot;
              </strong>{" "}
              in the box below
            </p>
            <input
              type="text"
              value={confirmInput}
              autoFocus
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={confirmTarget}
              className="w-full rounded-md border border-[var(--color-danger)]/50 bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-danger)]"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep("warning")}
              >
                Back
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={confirmInput !== confirmTarget || isPending}
                onClick={onConfirm}
              >
                {isPending ? "Deleting..." : `Delete ${confirmTarget}`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatsStep(
  props: DeleteEntityModalProps & { onNext: () => void; entityWord: string },
) {
  const { kind, onNext, entityWord } = props;

  return (
    <div className="space-y-4">
      {kind === "repo" ? (
        <RepoStats repoId={props.repoId} />
      ) : (
        <OrgStats orgId={props.orgId} />
      )}

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={onNext}>
          I want to delete this {entityWord}
        </Button>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-3">
      <div className="text-lg font-semibold text-[var(--color-text-primary)]">
        {value}
      </div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}

function RepoStats({ repoId }: { repoId: string }) {
  const { data, isLoading } = api.repo.getDeleteStats.useQuery({ id: repoId });

  if (isLoading || !data) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">Loading stats…</p>
    );
  }

  return (
    <>
      <p className="text-sm text-[var(--color-text-secondary)]">
        You are about to delete this repository. Here is what is at stake:
      </p>
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Size" value={formatSize(data.storageBytes)} />
        <StatTile label="Commits" value={data.commitCount.toLocaleString()} />
        <StatTile label="Branches" value={data.branchCount.toLocaleString()} />
        <StatTile
          label="Active checkouts"
          value={data.checkoutCount.toLocaleString()}
        />
      </div>
    </>
  );
}

function OrgStats({ orgId }: { orgId: string }) {
  const { data, isLoading } = api.org.getDeleteStats.useQuery({ id: orgId });

  if (isLoading || !data) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">Loading stats…</p>
    );
  }

  return (
    <>
      <p className="text-sm text-[var(--color-text-secondary)]">
        You are about to delete this organization. Here is what is at stake:
      </p>
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label={data.repoCount === 1 ? "Repository" : "Repositories"}
          value={data.repoCount.toLocaleString()}
        />
        <StatTile label="Total size" value={formatSize(data.totalStorageBytes)} />
      </div>
      <RepoListTable
        repos={data.repos}
        emptyMessage="This organization has no repositories."
      />
    </>
  );
}

function OrgRepoList({ orgId }: { orgId: string }) {
  const { data } = api.org.getDeleteStats.useQuery({ id: orgId });

  if (!data || data.repos.length === 0) return null;

  return (
    <RepoListTable
      repos={data.repos}
      emptyMessage="This organization has no repositories."
    />
  );
}

function RepoListTable({
  repos,
  emptyMessage,
}: {
  repos: { id: string; name: string; storageBytes: number }[];
  emptyMessage: string;
}) {
  if (repos.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">{emptyMessage}</p>
    );
  }

  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Repositories ({repos.length})
      </div>
      <ul className="max-h-48 divide-y divide-[var(--color-border-muted)] overflow-y-auto rounded-md border border-[var(--color-border-default)]">
        {repos.map((repo) => (
          <li
            key={repo.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="truncate text-sm text-[var(--color-text-primary)]">
              {repo.name}
            </span>
            <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
              {formatSize(repo.storageBytes)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
