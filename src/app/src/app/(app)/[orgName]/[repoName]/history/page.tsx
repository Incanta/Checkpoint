"use client";

import { useCallback, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Card, Badge, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const ITEM_HEIGHT = 28; // px per file row
const VISIBLE_COUNT = 50; // items visible at once
const BUFFER = 20; // extra items rendered above/below viewport
const MAX_CONTAINER_HEIGHT = ITEM_HEIGHT * VISIBLE_COUNT; // scroll container height

/** Windowed list that only renders items in/near the viewport. */
function VirtualFileList({
  files,
  changeTypeColor,
}: {
  files: { fileId: string; path: string; changeType: string; oldPath: string | null }[];
  changeTypeColor: Record<string, "success" | "warning" | "danger">;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const totalHeight = files.length * ITEM_HEIGHT;
  const needsVirtualization = files.length > VISIBLE_COUNT + BUFFER;

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  if (!needsVirtualization) {
    // Small list — render everything, no virtualization needed
    return (
      <div className="space-y-0">
        {files.map((f, i) => (
          <div
            key={i}
            className="flex items-center gap-2 text-sm"
            style={{ height: ITEM_HEIGHT }}
          >
            <Badge
              variant={changeTypeColor[f.changeType] ?? "default"}
              className="w-16 shrink-0 justify-center text-[10px]"
            >
              {f.changeType}
            </Badge>
            <span className="truncate text-[var(--color-text-secondary)]">
              {f.path}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Compute visible window
  const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
  const endIdx = Math.min(
    files.length,
    Math.ceil((scrollTop + MAX_CONTAINER_HEIGHT) / ITEM_HEIGHT) + BUFFER,
  );
  const topPad = startIdx * ITEM_HEIGHT;
  const bottomPad = (files.length - endIdx) * ITEM_HEIGHT;
  const visibleFiles = files.slice(startIdx, endIdx);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="overflow-y-auto"
      style={{ maxHeight: MAX_CONTAINER_HEIGHT }}
    >
      <div style={{ paddingTop: topPad, paddingBottom: bottomPad }}>
        {visibleFiles.map((f, i) => (
          <div
            key={startIdx + i}
            className="flex items-center gap-2 text-sm"
            style={{ height: ITEM_HEIGHT }}
          >
            <Badge
              variant={changeTypeColor[f.changeType] ?? "default"}
              className="w-16 shrink-0 justify-center text-[10px]"
            >
              {f.changeType}
            </Badge>
            <span className="truncate text-[var(--color-text-secondary)]">
              {f.path}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RepoHistoryPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const { data: branches } = api.branch.listBranches.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const activeBranch =
    branches?.find((b) => b.name === selectedBranch) ??
    branches?.find((b) => b.isDefault);
  useDocumentTitle(
    activeBranch
      ? `History at ${activeBranch.name} · ${repoName} in ${orgName}`
      : `History · ${repoName} in ${orgName}`,
  );

  const { data: changelists } = api.changelist.getChangelists.useQuery(
    {
      repoId: repoData?.id ?? "",
      branchName: activeBranch?.name ?? "main",
      start: { number: null, timestamp: null },
      count: 50,
    },
    { enabled: !!repoData?.id && !!activeBranch },
  );

  const [expandedCl, setExpandedCl] = useState<number | null>(null);

  const { data: clFiles } = api.changelist.getChangelistFiles.useQuery(
    { repoId: repoData?.id ?? "", changelistNumber: expandedCl ?? 0 },
    { enabled: !!repoData?.id && expandedCl != null },
  );

  const changeTypeColor = {
    ADD: "success" as const,
    MODIFY: "warning" as const,
    DELETE: "danger" as const,
  };

  return (
    <div>
      {/* Branch selector */}
      {branches && branches.length > 1 && (
        <div className="mb-4">
          <select
            value={activeBranch?.name ?? ""}
            onChange={(e) => setSelectedBranch(e.target.value)}
            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none"
          >
            {branches.map((b) => (
              <option key={b.id} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {changelists && changelists.length > 0 ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-default)]">
            {changelists.map((cl) => (
              <div key={cl.number}>
                <button
                  type="button"
                  onClick={() =>
                    setExpandedCl(expandedCl === cl.number ? null : cl.number)
                  }
                  className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-surface)]"
                >
                  <div className="shrink-0 pt-0.5">
                    <Badge variant="accent">#{cl.number}</Badge>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--color-text-primary)]">
                      {cl.message}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                      {(cl as any).user?.email ?? "unknown"} ·{" "}
                      {new Date(cl.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${expandedCl === cl.number ? "rotate-90" : ""}`}
                  >
                    <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
                  </svg>
                </button>

                {/* Expanded: file changes */}
                {expandedCl === cl.number && clFiles && (
                  <div className="border-t border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] px-4 py-2">
                    {clFiles.length > 0 ? (
                      <>
                        {clFiles.length > VISIBLE_COUNT && (
                          <div className="mb-1 text-xs text-[var(--color-text-muted)]">
                            {clFiles.length.toLocaleString()} files changed
                          </div>
                        )}
                        <VirtualFileList
                          files={clFiles}
                          changeTypeColor={changeTypeColor}
                        />
                      </>
                    ) : (
                      <p className="text-sm text-[var(--color-text-muted)]">
                        No file changes recorded.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No history yet"
          description="Submit files to this repository to see version history."
        />
      )}
    </div>
  );
}
