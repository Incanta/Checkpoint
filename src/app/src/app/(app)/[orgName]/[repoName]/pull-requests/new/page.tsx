"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function NewPullRequestPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  useDocumentTitle(`New Pull Request · ${repoName} in ${orgName}`);
  const router = useRouter();

  const { data: org } = api.org.getOrg.useQuery({ id: orgName, idIsName: true });
  const repoData = org?.repos?.find((r: { name: string }) => r.name === repoName);

  const { data: branches } = api.branch.listBranches.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  const [sourceBranch, setSourceBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [previewMd, setPreviewMd] = useState(false);

  // Auto-select target branch to the parent of source
  useEffect(() => {
    if (!sourceBranch || !branches) return;
    const src = branches.find((b) => b.name === sourceBranch);
    if (src?.parentBranchName) {
      setTargetBranch(src.parentBranchName);
    }
  }, [sourceBranch, branches]);

  const createPr = api.pullRequest.create.useMutation({
    onSuccess: (pr) => {
      router.push(`/${orgName}/${repoName}/pull-requests/${pr.number}`);
    },
  });

  const featureBranches = branches?.filter((b) => b.type === "FEATURE" && !b.archivedAt) ?? [];
  const targetBranches = branches?.filter((b) => !b.archivedAt && b.name !== sourceBranch) ?? [];

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
        New pull request
      </h2>

      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!repoData || !title.trim() || !sourceBranch || !targetBranch) return;
            createPr.mutate({
              repoId: repoData.id,
              title: title.trim(),
              description,
              sourceBranchName: sourceBranch,
              targetBranchName: targetBranch,
            });
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Source branch
              </label>
              <select
                value={sourceBranch}
                onChange={(e) => setSourceBranch(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none"
              >
                <option value="">Select branch…</option>
                {featureBranches.map((b) => (
                  <option key={b.id} value={b.name}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Target branch
              </label>
              <select
                value={targetBranch}
                onChange={(e) => setTargetBranch(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none"
              >
                <option value="">Select target…</option>
                {targetBranches.map((b) => (
                  <option key={b.id} value={b.name}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          {sourceBranch && targetBranch && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <span className="font-medium text-[var(--color-text-primary)]">{sourceBranch}</span>
              <span>→</span>
              <span className="font-medium text-[var(--color-text-primary)]">{targetBranch}</span>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a descriptive title"
              autoFocus
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                Description
              </label>
              <button
                type="button"
                onClick={() => setPreviewMd(!previewMd)}
                className="text-xs text-[var(--color-text-link)] hover:underline"
              >
                {previewMd ? "Edit" : "Preview"}
              </button>
            </div>
            {previewMd ? (
              <div className="min-h-[120px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)]">
                {description ? (
                  <MarkdownPreview content={description} />
                ) : (
                  <span className="text-[var(--color-text-muted)]">Nothing to preview</span>
                )}
              </div>
            ) : (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the changes in this pull request (Markdown supported)"
                rows={6}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
              />
            )}
          </div>

          {createPr.error && (
            <p className="text-sm text-[var(--color-danger)]">{createPr.error.message}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!title.trim() || !sourceBranch || !targetBranch || createPr.isPending}
            >
              {createPr.isPending ? "Creating…" : "Create pull request"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  // Lazy-load react-markdown to keep bundle small
  const [Md, setMd] = useState<React.ComponentType<{ children: string; remarkPlugins?: any[] }> | null>(null);
  const [remarkGfm, setRemarkGfm] = useState<any>(null);

  useEffect(() => {
    void Promise.all([
      import("react-markdown"),
      import("remark-gfm"),
    ]).then(([md, gfm]) => {
      setMd(() => md.default);
      setRemarkGfm(() => gfm.default);
    });
  }, []);

  if (!Md) return <span className="text-[var(--color-text-muted)]">Loading preview…</span>;

  return (
    <div className="prose prose-sm prose-invert max-w-none">
      <Md remarkPlugins={remarkGfm ? [remarkGfm] : []}>{content}</Md>
    </div>
  );
}
