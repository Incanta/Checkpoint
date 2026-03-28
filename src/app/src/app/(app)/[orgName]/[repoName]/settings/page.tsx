"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, Badge } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

function MergePermissionList({
  repoId,
  type,
  label,
}: {
  repoId: string;
  type: "MAINLINE" | "RELEASE";
  label: string;
}) {
  const utils = api.useUtils();
  const { data: permissions } = api.repo.getMergePermissions.useQuery({ repoId });
  const setPermissions = api.repo.setMergePermissions.useMutation({
    onSuccess: () => void utils.repo.getMergePermissions.invalidate(),
  });

  const current = permissions?.filter((p) => p.type === type) ?? [];
  const [newEmail, setNewEmail] = useState("");

  const handleAdd = () => {
    const email = newEmail.trim();
    if (!email) return;
    const emails = [...current.map((p) => p.user.email), email];
    setPermissions.mutate({ repoId, type, userEmails: emails });
    setNewEmail("");
  };

  const handleRemove = (emailToRemove: string) => {
    const emails = current.map((p) => p.user.email).filter((e) => e !== emailToRemove);
    setPermissions.mutate({ repoId, type, userEmails: emails });
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
        {label}
      </label>
      <p className="mb-2 text-xs text-[var(--color-text-muted)]">
        If empty, all members with write access can merge.
      </p>
      <div className="space-y-1.5">
        {current.map((p) => (
          <div key={p.id} className="flex items-center gap-2">
            <span className="text-sm text-[var(--color-text-primary)]">
              {p.user.name ?? p.user.email}
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">{p.user.email}</span>
            <button
              type="button"
              onClick={() => handleRemove(p.user.email)}
              className="ml-auto text-xs text-[var(--color-danger)] hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAdd())}
          placeholder="user@example.com"
          className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
        />
        <Button size="sm" onClick={handleAdd} disabled={!newEmail.trim()}>Add</Button>
      </div>
      {setPermissions.error && (
        <p className="mt-1 text-xs text-[var(--color-danger)]">{setPermissions.error.message}</p>
      )}
    </div>
  );
}

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

  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [requiredReviews, setRequiredReviews] = useState(0);
  const [mergePermissionsSame, setMergePermissionsSame] = useState(true);
  const [initialized, setInitialized] = useState(false);

  if (repoData && !initialized) {
    setName(repoData.name);
    setIsPublic(repoData.public);
    setRequiredReviews((repoData as any).requiredReviews ?? 0);
    setMergePermissionsSame((repoData as any).mergePermissionsSame ?? true);
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
              requiredReviews,
              mergePermissionsSame,
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

      {/* Pull Request / Merge settings */}
      <Card>
        <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
          Pull request settings
        </h3>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              Required approving reviews
            </label>
            <p className="mb-1.5 text-xs text-[var(--color-text-muted)]">
              Minimum number of approvals before a pull request can be merged. Set to 0 to allow merging without reviews.
            </p>
            <input
              type="number"
              min={0}
              value={requiredReviews}
              onChange={(e) => setRequiredReviews(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-20 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="merge-same"
              checked={mergePermissionsSame}
              onChange={(e) => setMergePermissionsSame(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            <label htmlFor="merge-same" className="text-sm text-[var(--color-text-primary)]">
              Use the same merge permissions for Mainline and Release branches
            </label>
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={updateRepo.isPending}
              onClick={() => {
                if (!repoData) return;
                updateRepo.mutate({
                  id: repoData.id,
                  requiredReviews,
                  mergePermissionsSame,
                });
              }}
            >
              {updateRepo.isPending ? "Saving..." : "Save PR settings"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Merge permissions */}
      {repoData && (
        <Card>
          <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
            Merge permissions
          </h3>
          <div className="space-y-6">
            <MergePermissionList
              repoId={repoData.id}
              type="MAINLINE"
              label={mergePermissionsSame ? "Authorized mergers" : "Mainline branch mergers"}
            />
            {!mergePermissionsSame && (
              <MergePermissionList
                repoId={repoData.id}
                type="RELEASE"
                label="Release branch mergers"
              />
            )}
          </div>
        </Card>
      )}

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
