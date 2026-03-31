"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Card, Badge, Button, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const BRANCH_TYPE_COLOR = {
  MAINLINE: "accent" as const,
  RELEASE: "info" as const,
  FEATURE: "success" as const,
};

export default function RepoBranchesPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  useDocumentTitle(`Branches · ${repoName} in ${orgName}`);

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const [showArchived, setShowArchived] = useState(false);
  const { data: branches } = api.branch.listBranches.useQuery(
    { repoId: repoData?.id ?? "", includeArchived: showArchived },
    { enabled: !!repoData?.id },
  );

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"FEATURE" | "RELEASE">("FEATURE");
  const [parentBranch, setParentBranch] = useState("");
  const utils = api.useUtils();

  const { data: access } = api.repo.getMyRepoAccess.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  const createBranch = api.branch.createBranch.useMutation({
    onSuccess: () => {
      setShowCreate(false);
      setNewName("");
      void utils.branch.listBranches.invalidate();
    },
  });

  const archiveBranch = api.branch.archiveBranch.useMutation({
    onSuccess: () => void utils.branch.listBranches.invalidate(),
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Show archived
          </label>
        </div>
        {access?.canWrite && (
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            New branch
          </Button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <Card className="mb-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!repoData || !newName.trim() || !parentBranch) return;
              createBranch.mutate({
                repoId: repoData.id,
                name: newName.trim(),
                type: newType,
                parentBranchName: parentBranch,
              });
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                  Branch name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="feature/my-feature"
                  autoFocus
                  className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                  Type
                </label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as "FEATURE" | "RELEASE")}
                  className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none"
                >
                  <option value="FEATURE">Feature</option>
                  <option value="RELEASE">Release</option>
                </select>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Parent branch
              </label>
              <select
                value={parentBranch}
                onChange={(e) => setParentBranch(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none"
              >
                <option value="">Select parent...</option>
                {branches
                  ?.filter((b) => !b.archivedAt)
                  .map((b) => (
                    <option key={b.id} value={b.name}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </div>
            {createBranch.error && (
              <p className="text-sm text-[var(--color-danger)]">{createBranch.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" disabled={createBranch.isPending}>
                {createBranch.isPending ? "Creating..." : "Create branch"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Branch list */}
      {branches && branches.length > 0 ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-default)]">
            {branches.map((branch) => (
              <div
                key={branch.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    {branch.name}
                  </span>
                  <Badge variant={BRANCH_TYPE_COLOR[branch.type as keyof typeof BRANCH_TYPE_COLOR] ?? "default"}>
                    {branch.type}
                  </Badge>
                  {branch.isDefault && <Badge variant="accent">default</Badge>}
                  {branch.archivedAt && <Badge variant="warning">archived</Badge>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--color-text-muted)]">
                    CL #{branch.headNumber}
                  </span>
                  {access?.canWrite && !branch.isDefault && !branch.archivedAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        repoData &&
                        archiveBranch.mutate({
                          repoId: repoData.id,
                          branchName: branch.name,
                        })
                      }
                    >
                      Archive
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState title="No branches" description="This repository has no branches." />
      )}
    </div>
  );
}
