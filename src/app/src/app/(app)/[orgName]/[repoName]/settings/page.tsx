"use client";

import { useState } from "react";
import { useParams, useRouter, notFound } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function RepoSettingsPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  useDocumentTitle(`Settings · ${repoName} in ${orgName}`);
  const router = useRouter();
  const utils = api.useUtils();

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const { data: access } = api.repo.getMyRepoAccess.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  if (access && !access.isAdmin) {
    notFound();
  }

  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [initialized, setInitialized] = useState(false);

  if (repoData && !initialized) {
    setName(repoData.name);
    setIsPublic(repoData.public);
    setInitialized(true);
  }

  const updateRepo = api.repo.updateRepo.useMutation({
    onSuccess: (updated) => {
      void utils.org.myOrgs.invalidate();
      void utils.org.getOrg.invalidate();
      if (updated.name !== repoName) {
        router.replace(`/${orgName}/${updated.name}/settings`);
      }
    },
  });

  const deleteRepo = api.repo.deleteRepo.useMutation({
    onSuccess: () => {
      void utils.org.myOrgs.invalidate();
      router.push(`/${orgName}`);
    },
  });

  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  return (
    <div className="space-y-6">
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!repoData) return;
            updateRepo.mutate({
              id: repoData.id,
              name: name.trim() || undefined,
              public: isPublic,
            });
          }}
          className="space-y-4"
        >
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              Repository name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="repo-public"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            <label htmlFor="repo-public" className="text-sm text-[var(--color-text-primary)]">
              Public repository
            </label>
          </div>

          {updateRepo.error && (
            <p className="text-sm text-[var(--color-danger)]">{updateRepo.error.message}</p>
          )}
          {updateRepo.isSuccess && (
            <p className="text-sm text-[var(--color-success)]">Settings saved.</p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={updateRepo.isPending}>
              {updateRepo.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </form>
      </Card>

      {/* Danger zone */}
      <Card className="border-[var(--color-danger)]/30">
        <h3 className="mb-3 text-lg font-semibold text-[var(--color-danger)]">
          Danger zone
        </h3>
        {!showDelete ? (
          <Button variant="danger" size="sm" onClick={() => setShowDelete(true)}>
            Delete this repository
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-text-secondary)]">
              Type <strong>{repoName}</strong> to confirm. This cannot be undone.
            </p>
            <input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={repoName}
              className="w-full rounded-md border border-[var(--color-danger)]/50 bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={deleteConfirm !== repoName || deleteRepo.isPending}
                onClick={() => repoData && deleteRepo.mutate({ id: repoData.id })}
              >
                {deleteRepo.isPending ? "Deleting..." : "Delete repository"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
