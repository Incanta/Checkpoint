"use client";

import { useState, useEffect, useId } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import {
  Card,
  Badge,
  Button,
  EmptyState,
} from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { codeToHtml } from "shiki";

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    json: "json", md: "markdown", py: "python", rs: "rust", go: "go",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", html: "html",
    css: "css", scss: "scss", sql: "sql", sh: "bash", bat: "batch",
    lua: "lua", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
    proto: "protobuf", graphql: "graphql", prisma: "prisma",
  };
  return langMap[ext] ?? "text";
}

const STATUS_COLORS = {
  ACTIVE: "success" as const,
  SUBMITTED: "accent" as const,
  DELETED: "danger" as const,
};

function FileIcon({ path }: { path: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const isFolder = false;

  const iconMap: Record<string, string> = {
    ts: "📘",
    tsx: "📘",
    js: "📒",
    jsx: "📒",
    json: "📋",
    md: "📝",
    py: "🐍",
    rs: "🦀",
    go: "🔵",
    c: "⚙️",
    cpp: "⚙️",
    h: "⚙️",
    yaml: "📋",
    yml: "📋",
    toml: "📋",
  };

  return <span className="mr-1.5">{iconMap[ext] ?? (isFolder ? "📁" : "📄")}</span>;
}

function FileViewer({ repoId, shelfName, filePath }: { repoId: string; shelfName: string; filePath: string }) {
  const { data, isLoading, error } = api.shelf.getFileContent.useQuery(
    { repoId, shelfName, filePath },
    { enabled: !!repoId && !!shelfName && !!filePath },
  );

  if (isLoading) {
    return (
      <div className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">
        Loading file…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-danger)]">
        Error loading file: {error.message}
      </div>
    );
  }

  if (!data) return null;

  if (data.isBinary) {
    return (
      <div className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">
        Binary file — cannot display content
      </div>
    );
  }

  if (data.tooLarge) {
    return (
      <div className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">
        File too large to display ({(data.size / 1024 / 1024).toFixed(1)} MB)
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--color-border-default)]">
      <ShikiCodeBlock content={data.content ?? ""} filePath={filePath} />
    </div>
  );
}

function ShikiCodeBlock({ content, filePath }: { content: string; filePath: string }) {
  const rawId = useId();
  const scopeId = `sc${rawId.replace(/:/g, "")}`;
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lang = getLanguageFromPath(filePath);
    codeToHtml(content, { lang, theme: "github-dark-default" })
      .then((result) => {
        if (!cancelled) {
          const processed = result.replace(
            /<\/span>\n<span class="line"/g,
            '</span><span class="line"',
          );
          setHtml(processed);
        }
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [content, filePath]);

  const lineCount = content.split("\n").length;
  const css = `
    #${scopeId} pre { margin: 0; padding: 0.75rem; overflow-x: auto; font-size: 0.8125rem; line-height: 1.5; }
    #${scopeId} .line { display: block; min-height: 1lh; }
    #${scopeId} .shiki { background: var(--color-bg-surface) !important; }
  `;

  if (!html) {
    return (
      <pre className="overflow-x-auto bg-[var(--color-bg-surface)] p-3 text-xs leading-relaxed text-[var(--color-text-primary)]">
        {content}
      </pre>
    );
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div id={scopeId} className="flex">
        <div className="select-none border-r border-[var(--color-border-default)] bg-[var(--color-bg-default)] px-3 py-3 text-right text-xs leading-relaxed text-[var(--color-text-muted)]">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className="flex-1 overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </>
  );
}

export default function ShelfDetailPage() {
  const params = useParams<{ orgName: string; repoName: string; shelfName: string }>();
  const router = useRouter();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const shelfName = decodeURIComponent(params.shelfName);
  const basePath = `/${orgName}/${repoName}`;

  useDocumentTitle(`${shelfName} · Shelves · ${repoName}`);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const [submitBranch, setSubmitBranch] = useState("");
  const [submitMessage, setSubmitMessage] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");

  const { data: org } = api.org.getOrg.useQuery({ id: orgName, idIsName: true });
  const repoData = org?.repos?.find((r: { name: string }) => r.name === repoName);

  const { data: shelf, isLoading, refetch } = api.shelf.get.useQuery(
    { repoId: repoData?.id ?? "", name: shelfName },
    { enabled: !!repoData?.id },
  );

  const { data: branches } = api.branch.listBranches.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id && showSubmitDialog },
  );

  const utils = api.useUtils();

  const submitMutation = api.shelf.submitToBranch.useMutation({
    onSuccess: () => {
      setShowSubmitDialog(false);
      void refetch();
      void utils.shelf.list.invalidate();
    },
  });

  const deleteMutation = api.shelf.delete.useMutation({
    onSuccess: () => {
      void utils.shelf.list.invalidate();
      router.push(`${basePath}/shelves`);
    },
  });

  const renameMutation = api.shelf.rename.useMutation({
    onSuccess: (updated) => {
      setIsEditing(false);
      void utils.shelf.list.invalidate();
      router.replace(`${basePath}/shelves/${encodeURIComponent(updated.name)}`);
    },
  });

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }

  if (!shelf) {
    return <EmptyState title="Shelf not found" description="This shelf doesn't exist or has been deleted." />;
  }

  const files = shelf.fileChanges.map((fc) => ({
    id: fc.file.id,
    path: fc.file.path,
    type: fc.type,
  }));

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-lg font-semibold text-[var(--color-text-primary)]"
                autoFocus
              />
              <Button
                size="sm"
                onClick={() => {
                  if (editName && editName !== shelfName && repoData?.id) {
                    renameMutation.mutate({
                      repoId: repoData.id,
                      shelfName,
                      newName: editName,
                    });
                  }
                }}
                disabled={!editName || editName === shelfName || renameMutation.isPending}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                {shelf.name}
              </h2>
              <Badge variant={STATUS_COLORS[shelf.status]}>{shelf.status}</Badge>
              {shelf.status === "ACTIVE" && (
                <button
                  type="button"
                  onClick={() => {
                    setEditName(shelf.name);
                    setIsEditing(true);
                  }}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                >
                  ✏️
                </button>
              )}
            </div>
          )}
          <div className="mt-1 flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
            <span>CL #{shelf.changelistNumber}</span>
            <span>by {shelf.author.name ?? shelf.author.email}</span>
            <span>Updated {new Date(shelf.updatedAt).toLocaleString()}</span>
            {shelf.submittedToBranch && (
              <span>→ {shelf.submittedToBranch}</span>
            )}
          </div>
          {shelf.description && (
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{shelf.description}</p>
          )}
        </div>
        {shelf.status === "ACTIVE" && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setShowSubmitDialog(true)}
              disabled={files.length === 0}
            >
              Submit to branch
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {/* Submit dialog */}
      {showSubmitDialog && (
        <Card className="mb-4">
          <h3 className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">
            Submit shelf to branch
          </h3>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
                Target branch
              </label>
              <select
                value={submitBranch}
                onChange={(e) => setSubmitBranch(e.target.value)}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
              >
                <option value="">Select branch…</option>
                {branches
                  ?.filter((b) => !b.archivedAt)
                  .map((b) => (
                    <option key={b.id} value={b.name}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
                Commit message (optional)
              </label>
              <input
                type="text"
                value={submitMessage}
                onChange={(e) => setSubmitMessage(e.target.value)}
                placeholder={`Applied shelf "${shelf.name}"`}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  if (repoData?.id && submitBranch) {
                    submitMutation.mutate({
                      repoId: repoData.id,
                      shelfName: shelf.name,
                      branchName: submitBranch,
                      message: submitMessage || undefined,
                    });
                  }
                }}
                disabled={!submitBranch || submitMutation.isPending}
              >
                {submitMutation.isPending ? "Submitting…" : "Squash and submit"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowSubmitDialog(false)}>
                Cancel
              </Button>
              {submitMutation.error && (
                <span className="text-xs text-[var(--color-danger)]">
                  {submitMutation.error.message}
                </span>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <Card className="mb-4">
          <p className="mb-3 text-sm text-[var(--color-text-primary)]">
            Are you sure you want to delete this shelf? This action cannot be undone.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (repoData?.id) {
                  deleteMutation.mutate({ repoId: repoData.id, shelfName: shelf.name });
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* File list */}
      <Card padding={false}>
        <div className="border-b border-[var(--color-border-default)] px-4 py-2">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </div>
        {files.length > 0 ? (
          <div className="divide-y divide-[var(--color-border-default)]">
            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={() =>
                  setSelectedFile(selectedFile === file.path ? null : file.path)
                }
                className={`flex w-full items-center px-4 py-2 text-left text-sm transition-colors hover:bg-[var(--color-bg-surface)] ${
                  selectedFile === file.path ? "bg-[var(--color-bg-surface)]" : ""
                }`}
              >
                <FileIcon path={file.path} />
                <span className="flex-1 text-[var(--color-text-primary)]">
                  {file.path}
                </span>
                <Badge variant="info" className="ml-2 text-xs">
                  {file.type}
                </Badge>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
            No files in this shelf
          </div>
        )}
      </Card>

      {/* File viewer */}
      {selectedFile && repoData?.id && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--color-text-primary)]">
              {selectedFile}
            </span>
            <button
              type="button"
              onClick={() => setSelectedFile(null)}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            >
              Close
            </button>
          </div>
          <FileViewer
            repoId={repoData.id}
            shelfName={shelf.name}
            filePath={selectedFile}
          />
        </div>
      )}
    </div>
  );
}
