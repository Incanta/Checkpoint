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

export default function IssuesListPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;
  useDocumentTitle(`Issues ${String.fromCharCode(183)} ${repoName} in ${orgName}`);

  const [statusFilter, setStatusFilter] = useState<"OPEN" | "CLOSED" | "ALL">("OPEN");
  const [labelFilter, setLabelFilter] = useState<string | undefined>(undefined);

  const { data: org } = api.org.getOrg.useQuery({ id: orgName, idIsName: true });
  const repoData = org?.repos?.find((r: { name: string }) => r.name === repoName);

  const { data: issues, isLoading } = api.issue.list.useQuery(
    { repoId: repoData?.id ?? "", status: statusFilter, labelId: labelFilter },
    { enabled: !!repoData?.id },
  );

  const { data: labels } = api.issue.listLabels.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

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
              {labels.map((l: any) => (
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
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Loading...</div>
      ) : issues && issues.length > 0 ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-muted)]">
            {issues.map((issue: any) => (
              <Link
                key={issue.id}
                href={`${basePath}/issues/${issue.number}`}
                className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-bg-surface)]"
              >
                <div className="shrink-0 pt-0.5">
                  {issue.status === "OPEN" ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-[var(--color-success)]">
                      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-[var(--color-danger)]">
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
                    {issue.labels?.map((ll: any) => (
                      <span
                        key={ll.label.id}
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none text-white"
                        style={{ backgroundColor: ll.label.color }}
                      >
                        {ll.label.name}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                    #{issue.number} opened by {issue.author?.name ?? issue.author?.email ?? "unknown"} on{" "}
                    {new Date(issue.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                    {issue._count.comments > 0 && (
                      <span className="ml-2">{issue._count.comments} comment{issue._count.comments !== 1 ? "s" : ""}</span>
                    )}
                  </div>
                </div>

                {issue.assignees?.length > 0 && (
                  <div className="flex -space-x-1">
                    {issue.assignees.slice(0, 3).map((a: any) => (
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