"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { Card, PageHeader, Badge, Button } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { AdminTabs } from "../_components/admin-tabs";
import { notFound } from "next/navigation";

const STATUS_COLORS: Record<
  string,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  TRIAL: "info",
  ACTIVE: "success",
  PAST_DUE: "warning",
  CANCELED: "danger",
  SUSPENDED: "danger",
  DELETED: "danger",
};

function daysSince(date: Date | string | null): number | null {
  if (!date) return null;
  const d = new Date(date);
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(date: Date | string | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

export default function AdminBillingPage() {
  useDocumentTitle("Admin · Billing");
  const { data: user, isLoading: userLoading } = api.user.me.useQuery();
  const { data: orgs, isLoading } = api.admin.getDelinquentOrgs.useQuery(
    undefined,
    { enabled: !!user?.checkpointAdmin },
  );

  if (!userLoading && !user?.checkpointAdmin) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Admin"
        description="Delinquent and problematic organizations"
      />
      <AdminTabs />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg bg-[var(--color-bg-secondary)]"
            />
          ))}
        </div>
      ) : orgs && orgs.length > 0 ? (
        <Card padding={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border-default)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Organization
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Delinquent Since
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Days
                  </th>
                  <th className="hidden px-4 py-3 text-right text-xs font-medium text-[var(--color-text-muted)] uppercase sm:table-cell">
                    Members
                  </th>
                  <th className="hidden px-4 py-3 text-right text-xs font-medium text-[var(--color-text-muted)] uppercase sm:table-cell">
                    Live Repos
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-default)]">
                {orgs.map((org) => (
                  <OrgRow key={org.id} org={org} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
            No delinquent or problematic organizations.
          </div>
        </Card>
      )}
    </div>
  );
}

function OrgRow({
  org,
}: {
  org: {
    id: string;
    name: string;
    subscriptionStatus: string;
    subscriptionTier: string;
    delinquentSince: Date | string | null;
    suspendedAt: Date | string | null;
    canceledAt: Date | string | null;
    deletedAt: Date | string | null;
    memberCount: number;
    liveRepoCount: number;
  };
}) {
  const [confirming, setConfirming] = useState(false);
  const utils = api.useUtils();
  const deleteRepos = api.admin.adminDeleteOrgRepos.useMutation({
    onSuccess: () => {
      setConfirming(false);
      void utils.admin.getDelinquentOrgs.invalidate();
    },
  });

  const days = daysSince(
    org.delinquentSince ?? org.canceledAt ?? org.deletedAt,
  );
  const canDeleteRepos =
    (org.subscriptionStatus === "CANCELED" ||
      org.subscriptionStatus === "DELETED" ||
      !!org.deletedAt) &&
    org.liveRepoCount > 0;

  const handleDelete = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    deleteRepos.mutate({ orgId: org.id });
  };

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-medium text-[var(--color-text-primary)]">
          {org.name}
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {org.subscriptionTier}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={STATUS_COLORS[org.subscriptionStatus] ?? "default"}>
          {org.subscriptionStatus}
        </Badge>
        {org.deletedAt && (
          <Badge variant="danger" className="ml-1">
            SOFT-DELETED
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 text-[var(--color-text-secondary)]">
        {formatDate(org.delinquentSince ?? org.canceledAt ?? org.deletedAt)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[var(--color-text-primary)]">
        {days !== null ? days : "—"}
      </td>
      <td className="hidden px-4 py-3 text-right text-[var(--color-text-secondary)] sm:table-cell">
        {org.memberCount}
      </td>
      <td className="hidden px-4 py-3 text-right text-[var(--color-text-secondary)] sm:table-cell">
        {org.liveRepoCount}
      </td>
      <td className="px-4 py-3 text-right">
        {canDeleteRepos && (
          <div className="flex items-center justify-end gap-2">
            {confirming && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleteRepos.isPending}
              >
                Cancel
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={deleteRepos.isPending}
            >
              {deleteRepos.isPending
                ? "Deleting…"
                : confirming
                  ? "Confirm"
                  : "Delete Repos"}
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}
