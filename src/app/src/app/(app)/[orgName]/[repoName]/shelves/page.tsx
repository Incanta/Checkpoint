"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Card, Badge, Button, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const STATUS_COLORS = {
  ACTIVE: "success" as const,
  SUBMITTED: "accent" as const,
  DELETED: "danger" as const,
};

export default function ShelvesListPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;
  useDocumentTitle(`Shelves · ${repoName} in ${orgName}`);

  const [statusFilter, setStatusFilter] = useState<
    "ACTIVE" | "SUBMITTED" | undefined
  >("ACTIVE");

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const { data: shelves, isLoading } = api.shelf.list.useQuery(
    {
      repoId: repoData?.id ?? "",
      status: statusFilter,
    },
    { enabled: !!repoData?.id },
  );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] text-sm">
          {(
            [
              { key: "ACTIVE", label: "Active" },
              { key: "SUBMITTED", label: "Submitted" },
              { key: undefined, label: "All" },
            ] as const
          ).map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setStatusFilter(s.key)}
              className={`px-3 py-1.5 transition-colors ${
                statusFilter === s.key
                  ? "bg-[var(--color-bg-overlay)] font-medium text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
          Loading…
        </div>
      ) : shelves && shelves.length > 0 ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-default)]">
            {shelves.map((shelf) => (
              <Link
                key={shelf.id}
                href={`${basePath}/shelves/${encodeURIComponent(shelf.name)}`}
                className="block px-4 py-3 transition-colors hover:bg-[var(--color-bg-surface)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_COLORS[shelf.status]}>
                        {shelf.status}
                      </Badge>
                      <span className="text-sm font-medium text-[var(--color-text-primary)]">
                        {shelf.name}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
                      <span>CL #{shelf.changelistNumber}</span>
                      <span>
                        {shelf._count.fileChanges}{" "}
                        {shelf._count.fileChanges === 1 ? "file" : "files"}
                      </span>
                      <span>
                        by {shelf.author.name ?? shelf.author.email}
                      </span>
                      <span>
                        {new Date(shelf.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                    {shelf.description && (
                      <p className="mt-1 truncate text-xs text-[var(--color-text-secondary)]">
                        {shelf.description}
                      </p>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No shelves"
          description={
            statusFilter === "ACTIVE"
              ? "There are no active shelves. Use the CLI to shelve files."
              : "No shelves match the current filter."
          }
        />
      )}
    </div>
  );
}
