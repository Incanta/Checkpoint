"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Card, Badge, Button, Avatar, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const STATUS_COLORS = {
  OPEN: "success" as const,
  CLOSED: "danger" as const,
};

function CheckpointIssuesList({
  repoId,
  basePath,
}: {
  repoId: string;
  basePath: string;
}) {
  const [statusFilter, setStatusFilter] = useState<"OPEN" | "CLOSED" | "ALL">(
    "OPEN",
  );
  const [labelFilter, setLabelFilter] = useState<string | undefined>(undefined);

  const { data: issues, isLoading } = api.issue.list.useQuery({
    repoId,
    status: statusFilter,
    labelId: labelFilter,
  });

  const { data: labels } = api.issue.listLabels.useQuery({ repoId });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] text-sm">
            {(["OPEN", "CLOSED", "ALL"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 transition-colors ${
                  statusFilter === s
                    ? "bg-[var(--color-bg-overlay)] font-medium text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                }`}
              >
                {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          {labels && labels.length > 0 && (
            <select
              value={labelFilter ?? ""}
              onChange={(e) => setLabelFilter(e.target.value || undefined)}
              className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none"
            >
              <option value="">All labels</option>
              {labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l._count.issues})
                </option>
              ))}
            </select>
          )}
        </div>

        <Link href={`${basePath}/issues/new`}>
          <Button>New Issue</Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
          Loading...
        </div>
      ) : issues && issues.length > 0 ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-muted)]">
            {issues.map((issue) => (
              <Link
                key={issue.id}
                href={`${basePath}/issues/${issue.number}`}
                className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-bg-surface)]"
              >
                <div className="shrink-0 pt-0.5">
                  {issue.status === "OPEN" ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="text-[var(--color-success)]"
                    >
                      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="text-[var(--color-danger)]"
                    >
                      <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z" />
                      <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" />
                    </svg>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">
                      {issue.title}
                    </span>
                    {issue.labels?.map((ll) => (
                      <span
                        key={ll.label.id}
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-none font-medium text-white"
                        style={{ backgroundColor: ll.label.color }}
                      >
                        {ll.label.name}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                    #{issue.number} opened by{" "}
                    {issue.author?.name ?? issue.author?.email ?? "unknown"} on{" "}
                    {new Date(issue.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                    {issue._count.comments > 0 && (
                      <span className="ml-2">
                        {issue._count.comments} comment
                        {issue._count.comments !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                {issue.assignees?.length > 0 && (
                  <div className="flex -space-x-1">
                    {issue.assignees.slice(0, 3).map((a) => (
                      <Avatar
                        key={a.user.id}
                        src={a.user.image}
                        name={a.user.name}
                        email={a.user.email}
                        size="sm"
                      />
                    ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No issues"
          description={
            statusFilter === "ALL"
              ? "Create an issue to start tracking work."
              : `No ${statusFilter.toLowerCase()} issues.`
          }
        />
      )}
    </div>
  );
}

const PLATFORM_LABELS: Record<string, string> = {
  JIRA: "Jira",
  CODECKS: "Codecks",
  HACKNPLAN: "HacknPlan",
};

function ExternalIssuesList({
  repoId,
  platform,
  basePath,
}: {
  repoId: string;
  platform: string;
  basePath: string;
}) {
  const {
    data: issues,
    isLoading,
    error,
  } = api.issueTracker.listExternal.useQuery({ repoId }, { retry: false });

  const { data: access } = api.repo.getMyRepoAccess.useQuery({ repoId });

  const platformLabel = PLATFORM_LABELS[platform] ?? platform;

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        title={`Could not load issues from ${platformLabel}`}
        description={error.message}
        action={
          access?.isAdmin ? (
            <Link
              href={`${basePath}/settings`}
              className="text-sm text-[var(--color-info)] hover:underline"
            >
              Check the issue settings
            </Link>
          ) : undefined
        }
      />
    );
  }

  if (!issues || issues.length === 0) {
    return (
      <EmptyState
        title="No issues"
        description={`No issues were found in the connected ${platformLabel} project.`}
      />
    );
  }

  return (
    <div>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Issues are tracked in {platformLabel}. Selecting an issue opens it there
        in a new tab.
      </p>
      <Card padding={false}>
        <div className="divide-y divide-[var(--color-border-muted)]">
          {issues.map((issue) => (
            <a
              key={issue.id}
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-bg-surface)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-mono text-xs text-[var(--color-text-muted)]">
                    {issue.displayId}
                  </span>
                  <span className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                    {issue.title}
                  </span>
                  {issue.status && <Badge>{issue.status}</Badge>}
                  {issue.labels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center rounded-full bg-[var(--color-bg-overlay)] px-2 py-0.5 text-[10px] leading-none font-medium text-[var(--color-text-secondary)]"
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                  {issue.type && <span className="mr-2">{issue.type}</span>}
                  {issue.assignee && (
                    <span className="mr-2">Assigned to {issue.assignee}</span>
                  )}
                  {issue.updatedAt && (
                    <span>
                      Updated{" "}
                      {new Date(issue.updatedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  )}
                </div>
              </div>

              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="mt-1 shrink-0 text-[var(--color-text-muted)]"
              >
                <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Z" />
                <path d="M6.194 9.806a.75.75 0 0 1 0-1.06L12.44 2.5h-1.69a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V3.56L7.254 9.806a.75.75 0 0 1-1.06 0Z" />
              </svg>
            </a>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default function IssuesListPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;
  useDocumentTitle(
    `Issues ${String.fromCharCode(183)} ${repoName} in ${orgName}`,
  );

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  if (!repoData) {
    return (
      <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
        Loading...
      </div>
    );
  }

  if (repoData.issuesPlatform === "DISABLED") {
    return (
      <EmptyState
        title="Issues are disabled for this repository"
        description="A repository admin can re-enable them in settings."
      />
    );
  }

  if (repoData.issuesPlatform !== "CHECKPOINT") {
    return (
      <ExternalIssuesList
        repoId={repoData.id}
        platform={repoData.issuesPlatform}
        basePath={basePath}
      />
    );
  }

  return <CheckpointIssuesList repoId={repoData.id} basePath={basePath} />;
}
