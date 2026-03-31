"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { notFound } from "next/navigation";
import { api } from "~/trpc/react";
import { Card, Badge, Button, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function RepoCheckoutsPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  useDocumentTitle(`Checkouts · ${repoName} in ${orgName}`);

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const [lockedOnly, setLockedOnly] = useState(false);
  const utils = api.useUtils();

  const { data: access } = api.repo.getMyRepoAccess.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  if (access && !access.isMember) {
    notFound();
  }

  const { data: checkouts } = api.file.getRepoCheckouts.useQuery(
    { repoId: repoData?.id ?? "", lockedOnly },
    { enabled: !!repoData?.id },
  );

  const unlockFile = api.file.adminUnlockFile.useMutation({
    onSuccess: () => void utils.file.getRepoCheckouts.invalidate(),
  });

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={lockedOnly}
            onChange={(e) => setLockedOnly(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Locked only
        </label>
      </div>

      {checkouts && checkouts.length > 0 ? (
        <Card padding={false}>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--color-border-default)] text-xs font-medium text-[var(--color-text-muted)]">
                <th className="px-4 py-2 font-medium">File</th>
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="w-20 px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-default)]">
              {checkouts.map((checkout) => (
                <tr key={checkout.id}>
                  <td className="px-4 py-3">
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">
                      {checkout.filePath}
                    </span>
                    <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                      {checkout.workspaceName}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--color-text-secondary)]">
                    {checkout.user.name ??
                      checkout.user.username ??
                      checkout.user.email}
                  </td>
                  <td className="px-4 py-3">
                    {checkout.locked ? (
                      <Badge variant="warning">Locked</Badge>
                    ) : (
                      <Badge variant="default">Checked out</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {checkout.locked && access?.isAdmin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          repoData &&
                          unlockFile.mutate({
                            repoId: repoData.id,
                            checkoutId: checkout.id,
                          })
                        }
                        disabled={unlockFile.isPending}
                      >
                        Unlock
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No active checkouts"
          description={
            lockedOnly
              ? "No files are currently locked in this repo."
              : "No files are currently checked out in this repo."
          }
        />
      )}

      {unlockFile.error && (
        <p className="mt-2 text-sm text-[var(--color-danger)]">
          {unlockFile.error.message}
        </p>
      )}
    </div>
  );
}
