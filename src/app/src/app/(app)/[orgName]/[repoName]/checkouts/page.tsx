"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { notFound } from "next/navigation";
import { api } from "~/trpc/react";
import { Card, Badge, Button, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function RepoClaimsPage() {
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

  const [exclusiveOnly, setExclusiveOnly] = useState(false);
  const utils = api.useUtils();

  const { data: access } = api.repo.getMyRepoAccess.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  if (access && !access.isMember) {
    notFound();
  }

  const { data: claims } = api.file.getRepoClaims.useQuery(
    { repoId: repoData?.id ?? "", exclusiveOnly },
    { enabled: !!repoData?.id },
  );

  const forceRelease = api.file.forceReleaseClaim.useMutation({
    onSuccess: () => void utils.file.getRepoClaims.invalidate(),
  });

  // A claim blocks its whole claim domain, so the domain is the unit that
  // matters when you are looking for who is holding what.
  const byDomain = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof claims>>();
    for (const claim of claims ?? []) {
      const bucket = groups.get(claim.domainBranchName) ?? [];
      bucket.push(claim);
      groups.set(claim.domainBranchName, bucket);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [claims]);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={exclusiveOnly}
            onChange={(e) => setExclusiveOnly(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Exclusive only
        </label>
      </div>

      {byDomain.length > 0 ? (
        <div className="flex flex-col gap-6">
          {byDomain.map(([domainBranchName, domainClaims]) => (
            <div key={domainBranchName}>
              <h2 className="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">
                {domainBranchName}
                <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">
                  {domainClaims.length} claim
                  {domainClaims.length === 1 ? "" : "s"}
                </span>
              </h2>
              <Card padding={false}>
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[var(--color-border-default)] text-xs font-medium text-[var(--color-text-muted)]">
                      <th className="px-4 py-2 font-medium">File</th>
                      <th className="px-4 py-2 font-medium">Branch</th>
                      <th className="px-4 py-2 font-medium">User</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="w-20 px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border-default)]">
                    {domainClaims.map((claim) => (
                      <tr key={claim.id}>
                        <td className="px-4 py-3">
                          <span className="text-sm font-medium text-[var(--color-text-primary)]">
                            {claim.filePath}
                          </span>
                          <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                            {claim.workspaceName}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm whitespace-nowrap text-[var(--color-text-secondary)]">
                          {claim.branchName}
                          {claim.branchName !== claim.domainBranchName && (
                            <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                              (in flight)
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm whitespace-nowrap text-[var(--color-text-secondary)]">
                          {claim.user.name ??
                            claim.user.username ??
                            claim.user.email}
                        </td>
                        <td className="px-4 py-3">
                          {claim.strength === "EXCLUSIVE" ? (
                            <Badge variant="warning">
                              {claim.state === "SUBMITTED"
                                ? "Exclusive · submitted"
                                : "Exclusive"}
                            </Badge>
                          ) : (
                            <Badge variant="default">
                              {claim.state === "SUBMITTED"
                                ? "Advisory · submitted"
                                : "Advisory"}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {claim.strength === "EXCLUSIVE" &&
                            access?.isAdmin && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  repoData &&
                                  forceRelease.mutate({
                                    repoId: repoData.id,
                                    claimId: claim.id,
                                  })
                                }
                                disabled={forceRelease.isPending}
                              >
                                Release
                              </Button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No active claims"
          description={
            exclusiveOnly
              ? "No files are exclusively claimed in this repo."
              : "No files are currently checked out in this repo."
          }
        />
      )}

      {forceRelease.error && (
        <p className="mt-2 text-sm text-[var(--color-danger)]">
          {forceRelease.error.message}
        </p>
      )}
    </div>
  );
}
