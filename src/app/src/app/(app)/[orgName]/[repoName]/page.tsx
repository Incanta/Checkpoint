"use client";

import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Card, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

function FolderIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 text-[var(--color-info)]"
    >
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 text-[var(--color-text-muted)]"
    >
      <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
    </svg>
  );
}

function Breadcrumb({
  folderPath,
  onNavigate,
}: {
  folderPath: string;
  onNavigate: (path: string) => void;
}) {
  const parts = folderPath === "" ? [] : folderPath.split("/");

  return (
    <div className="flex items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onNavigate("")}
        className={`rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--color-bg-surface)] ${
          parts.length === 0
            ? "font-medium text-[var(--color-text-primary)]"
            : "text-[var(--color-text-link)] hover:underline"
        }`}
      >
        /
      </button>
      {parts.map((part, i) => {
        const path = parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        return (
          <span key={path} className="flex items-center gap-1">
            <span className="text-[var(--color-text-muted)]">/</span>
            <button
              type="button"
              onClick={() => onNavigate(path)}
              className={`rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--color-bg-surface)] ${
                isLast
                  ? "font-medium text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-link)] hover:underline"
              }`}
            >
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}

export default function RepoFilesPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const searchParams = useSearchParams();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;

  const [folderPath, setFolderPath] = useState(
    searchParams.get("folder") ?? "",
  );

  // Sync with URL search params when they change (e.g. back navigation)
  useEffect(() => {
    setFolderPath(searchParams.get("folder") ?? "");
  }, [searchParams]);

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

  const defaultBranch = branches?.find((b) => b.isDefault);
  useDocumentTitle(
    defaultBranch
      ? `Files at ${defaultBranch.name} · ${repoName} in ${orgName}`
      : `Files · ${repoName} in ${orgName}`,
  );

  const { data: folder, isLoading } = api.file.listFolder.useQuery(
    {
      repoId: repoData?.id ?? "",
      changelistNumber: defaultBranch?.headNumber ?? 0,
      folderPath,
    },
    { enabled: !!repoData?.id && defaultBranch?.headNumber != null },
  );

  if (!repoData) {
    return (
      <EmptyState
        title="Repository not found"
        description={`Could not find ${orgName}/${repoName}.`}
      />
    );
  }

  const hasContent =
    folder && (folder.folders.length > 0 || folder.files.length > 0);

  return (
    <div>
      {defaultBranch && (
        <div className="mb-4 flex items-center gap-4 text-sm text-[var(--color-text-secondary)]">
          <span>
            Branch:{" "}
            <span className="font-medium text-[var(--color-text-primary)]">
              {defaultBranch.name}
            </span>
          </span>
          <span>CL #{defaultBranch.headNumber}</span>
          {folder && (
            <span>{folder.totalFileCount.toLocaleString()} files</span>
          )}
        </div>
      )}

      {defaultBranch && (
        <div className="mb-3">
          <Breadcrumb folderPath={folderPath} onNavigate={setFolderPath} />
        </div>
      )}

      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
          Loading…
        </div>
      ) : hasContent ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-muted)]">
            {folder.folders.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() =>
                  setFolderPath(
                    folderPath === "" ? name : `${folderPath}/${name}`,
                  )
                }
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-[var(--color-bg-surface)]"
              >
                <FolderIcon />
                <span className="min-w-0 truncate text-sm text-[var(--color-text-primary)]">
                  {name}
                </span>
              </button>
            ))}
            {folder.files.map((file) => (
              <Link
                key={file.path}
                href={`${basePath}/file/${file.path}`}
                className="flex w-full items-center gap-2 px-4 py-1.5 transition-colors hover:bg-[var(--color-bg-surface)]"
              >
                <FileIcon />
                <span className="min-w-0 truncate text-sm text-[var(--color-text-primary)]">
                  {file.name}
                </span>
                <span className="ml-auto shrink-0 text-xs text-[var(--color-text-muted)]">
                  CL #{file.lastCl}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No files yet"
          description="This repository is empty. Submit files using the CLI or desktop client."
        />
      )}
    </div>
  );
}
