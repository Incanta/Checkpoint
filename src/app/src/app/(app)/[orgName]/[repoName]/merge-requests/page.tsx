"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Card, Badge, Button, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const STATUS_COLORS = {
  OPEN: "success" as const,
  MERGED: "accent" as const,
  CLOSED: "danger" as const,
};

function ReviewSummary({ reviews }: { reviews: { state: string }[] }) {
  const approved = reviews.filter((r) => r.state === "APPROVED").length;
  const changes = reviews.filter((r) => r.state === "REQUEST_CHANGES").length;
  const pending = reviews.filter((r) => r.state === "PENDING").length;

  if (reviews.length === 0) return null;

  return (
    <span className="flex items-center gap-1.5 text-xs">
      {approved > 0 && <span className="text-[var(--color-success)]">✓ {approved}</span>}
      {changes > 0 && <span className="text-[var(--color-danger)]">✗ {changes}</span>}
      {pending > 0 && <span className="text-[var(--color-text-muted)]">◷ {pending}</span>}
    </span>
  );
}

export default function MergeRequestsListPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;
  useDocumentTitle(`Merge Requests · ${repoName} in ${orgName}`);

  const [statusFilter, setStatusFilter] = useState<"OPEN" | "CLOSED" | "ALL">("OPEN");

  const { data: org } = api.org.getOrg.useQuery({ id: orgName, idIsName: true });
  const repoData = org?.repos?.find((r: { name: string }) => r.name === repoName);

  const { data: mergeRequests, isLoading } = api.mergeRequest.list.useQuery(
    { repoId: repoData?.id ?? "", status: statusFilter },
    { enabled: !!repoData?.id },
  );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
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
              {s === "ALL" ? "All" : s === "OPEN" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
        <Link href={`${basePath}/merge-requests/new`}>
          <Button size="sm">New merge request</Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
      ) : mergeRequests && mergeRequests.length > 0 ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-default)]">
            {mergeRequests.map((mr) => (
              <Link
                key={mr.id}
                href={`${basePath}/merge-requests/${mr.number}`}
                className="block px-4 py-3 transition-colors hover:bg-[var(--color-bg-surface)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_COLORS[mr.status]}>{mr.status}</Badge>
                      <span className="text-sm font-medium text-[var(--color-text-primary)]">
                        {mr.title}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
                      <span>#{mr.number}</span>
                      <span>
                        {mr.sourceBranchName} → {mr.targetBranchName}
                      </span>
                      <span>by {mr.author.name ?? mr.author.email}</span>
                      <span>{new Date(mr.createdAt).toLocaleDateString()}</span>
                      {mr._count.comments > 0 && <span>💬 {mr._count.comments}</span>}
                    </div>
                  </div>
                  <ReviewSummary reviews={mr.reviews} />
                </div>
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No merge requests"
          description={
            statusFilter === "OPEN"
              ? "There are no open merge requests. Create one to start a code review."
              : "No merge requests match the current filter."
          }
        />
      )}
    </div>
  );
}
