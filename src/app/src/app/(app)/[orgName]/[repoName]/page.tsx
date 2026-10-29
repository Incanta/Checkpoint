"use client";

import { Suspense, useCallback, type MouseEvent } from "react";
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

// Folder entries are real links so ctrl/middle-click and "copy link" work.
// A plain left click is handled in-page instead of following the href.
function handleFolderClick(
  e: MouseEvent<HTMLAnchorElement>,
  path: string,
  onNavigate: (path: string) => void,
) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  e.preventDefault();
  onNavigate(path);
}

function Breadcrumb({
  folderPath,
  hrefFor,
  onNavigate,
}: {
  folderPath: string;
  hrefFor: (path: string) => string;
  onNavigate: (path: string) => void;
}) {
  const parts = folderPath === "" ? [] : folderPath.split("/");

  return (
    <div className="flex items-center gap-1 text-sm">
      <a
        href={hrefFor("")}
        onClick={(e) => handleFolderClick(e, "", onNavigate)}
        className={`rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--color-bg-surface)] ${
          parts.length === 0
            ? "font-medium text-[var(--color-text-primary)]"
            : "text-[var(--color-text-link)] hover:underline"
        }`}
      >
        /
      </a>
      {parts.map((part, i) => {
        const path = parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        return (
          <span key={path} className="flex items-center gap-1">
            <span className="text-[var(--color-text-muted)]">/</span>
            <a
              href={hrefFor(path)}
              onClick={(e) => handleFolderClick(e, path, onNavigate)}
              className={`rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--color-bg-surface)] ${
                isLast
                  ? "font-medium text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-link)] hover:underline"
              }`}
            >
              {part}
            </a>
          </span>
        );
      })}
    </div>
  );
}

export default function RepoFilesPage() {
  return (
    <Suspense>
      <RepoFilesPageContent />
    </Suspense>
  );
}

function RepoFilesPageContent() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const searchParams = useSearchParams();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;

  // The URL is the source of truth for the open folder, so a copied link
  // reopens the same folder and back/forward steps through folders.
  const folderPath = searchParams.get("folder") ?? "";

  const folderHref = useCallback(
    (path: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (path === "") {
        next.delete("folder");
      } else {
        next.set("folder", path);
      }
      const query = next.toString();
      return query ? `${basePath}?${query}` : basePath;
    },
    [searchParams, basePath],
  );

  // Native pushState is synced with the Next router (it updates
  // useSearchParams), so this changes folders without a page load or
  // server round trip, and adds a history entry for back/forward.
  const navigateToFolder = useCallback(
    (path: string) => {
      if (path === folderPath) return;
      window.history.pushState(null, "", folderHref(path));
    },
    [folderPath, folderHref],
  );

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
          <Breadcrumb
            folderPath={folderPath}
            hrefFor={folderHref}
            onNavigate={navigateToFolder}
          />
        </div>
      )}

      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
          Loading…
        </div>
      ) : hasContent ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-muted)]">
            {folder.folders.map((name) => {
              const path = folderPath === "" ? name : `${folderPath}/${name}`;
              return (
                <a
                  key={name}
                  href={folderHref(path)}
                  onClick={(e) => handleFolderClick(e, path, navigateToFolder)}
                  className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-[var(--color-bg-surface)]"
                >
                  <FolderIcon />
                  <span className="min-w-0 truncate text-sm text-[var(--color-text-primary)]">
                    {name}
                  </span>
                </a>
              );
            })}
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
