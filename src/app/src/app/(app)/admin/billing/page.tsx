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

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
        description="Billing management and delinquency tracking"
      />
      <AdminTabs />

      <div className="space-y-8">
        <CreditManager />

        <div>
          <h2 className="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">
            Delinquent Organizations
          </h2>
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
      </div>
    </div>
  );
}

function CreditManager() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedOrg, setSelectedOrg] = useState<{
    id: string;
    name: string;
    subscriptionTier: string;
    subscriptionStatus: string;
  } | null>(null);
  const [action, setAction] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const utils = api.useUtils();

  const { data: searchResults } = api.admin.searchOrgs.useQuery(
    { query: searchQuery },
    { enabled: searchQuery.length >= 1 },
  );

  const { data: balanceData } = api.admin.getOrgCreditBalance.useQuery(
    { orgId: selectedOrg?.id ?? "" },
    { enabled: !!selectedOrg },
  );

  const adjustCredit = api.admin.adjustCredit.useMutation({
    onSuccess: (data) => {
      const verb = action === "add" ? "Added" : "Removed";
      setSuccessMsg(
        `${verb} ${formatCents(parseInt(amount, 10))} credit. New balance: ${formatCents(data.creditBalanceCents)}`,
      );
      setAmount("");
      setDescription("");
      void utils.admin.getOrgCreditBalance.invalidate({
        orgId: selectedOrg?.id ?? "",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrg || !amount || !description) return;

    const cents = parseInt(amount, 10);
    if (isNaN(cents) || cents <= 0) return;

    setSuccessMsg(null);
    adjustCredit.mutate({
      orgId: selectedOrg.id,
      amountCents: cents,
      action,
      description,
    });
  };

  const handleSelectOrg = (org: {
    id: string;
    name: string;
    subscriptionTier: string;
    subscriptionStatus: string;
  }) => {
    setSelectedOrg(org);
    setSearchQuery("");
    setSuccessMsg(null);
  };

  const inputClass =
    "w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]";

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">
        Credit Management
      </h2>
      <Card>
        <div className="space-y-4">
          {/* Org Search */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)] uppercase">
              Organization
            </label>
            {selectedOrg ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--color-text-primary)]">
                    {selectedOrg.name}
                  </span>
                  <Badge
                    variant={
                      STATUS_COLORS[selectedOrg.subscriptionStatus] ?? "default"
                    }
                  >
                    {selectedOrg.subscriptionStatus}
                  </Badge>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {selectedOrg.subscriptionTier}
                  </span>
                </div>
                {balanceData && (
                  <span className="text-sm text-[var(--color-text-secondary)]">
                    Balance:{" "}
                    <span className="font-mono font-medium">
                      {formatCents(balanceData.creditBalanceCents)}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedOrg(null)}
                  className="ml-auto text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by organization name…"
                  className={inputClass}
                  autoFocus
                />
                {searchQuery.length >= 1 && searchResults && (
                  <div className="absolute z-10 mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] shadow-lg">
                    {searchResults.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-[var(--color-text-muted)]">
                        No organizations found
                      </div>
                    ) : (
                      searchResults.map((org) => (
                        <button
                          key={org.id}
                          type="button"
                          onClick={() => handleSelectOrg(org)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-secondary)]"
                        >
                          <span className="font-medium text-[var(--color-text-primary)]">
                            {org.name}
                          </span>
                          <Badge
                            variant={
                              STATUS_COLORS[org.subscriptionStatus] ?? "default"
                            }
                          >
                            {org.subscriptionStatus}
                          </Badge>
                          <span className="text-xs text-[var(--color-text-muted)]">
                            {org.subscriptionTier}
                          </span>
                          <span className="ml-auto text-xs text-[var(--color-text-muted)]">
                            {formatCents(org.creditBalanceCents)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Credit Form */}
          {selectedOrg && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                {/* Action Toggle */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Action
                  </label>
                  <div className="flex rounded-md border border-[var(--color-border-default)]">
                    <button
                      type="button"
                      onClick={() => setAction("add")}
                      className={`flex-1 rounded-l-md px-3 py-2 text-sm font-medium transition-colors ${
                        action === "add"
                          ? "bg-[var(--color-accent)] text-white"
                          : "bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                      }`}
                    >
                      Add Credit
                    </button>
                    <button
                      type="button"
                      onClick={() => setAction("remove")}
                      className={`flex-1 rounded-r-md px-3 py-2 text-sm font-medium transition-colors ${
                        action === "remove"
                          ? "bg-red-600 text-white"
                          : "bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                      }`}
                    >
                      Remove Credit
                    </button>
                  </div>
                </div>

                {/* Amount */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Amount (cents)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="e.g. 500 = $5.00"
                    className={inputClass}
                    required
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)] uppercase">
                    Reason
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Reason for adjustment"
                    className={inputClass}
                    required
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  variant={action === "add" ? "primary" : "danger"}
                  disabled={
                    adjustCredit.isPending || !amount || !description
                  }
                >
                  {adjustCredit.isPending
                    ? "Processing…"
                    : action === "add"
                      ? `Add ${amount ? formatCents(parseInt(amount, 10) || 0) : "$0.00"} Credit`
                      : `Remove ${amount ? formatCents(parseInt(amount, 10) || 0) : "$0.00"} Credit`}
                </Button>

                {successMsg && (
                  <span className="text-sm text-green-500">{successMsg}</span>
                )}
                {adjustCredit.error && (
                  <span className="text-sm text-red-500">
                    {adjustCredit.error.message}
                  </span>
                )}
              </div>
            </form>
          )}
        </div>
      </Card>
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
