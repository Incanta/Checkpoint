"use client";

import { api } from "~/trpc/react";
import { Card, PageHeader, Badge } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { AdminTabs } from "./_components/admin-tabs";
import { notFound } from "next/navigation";

const TIER_COLORS: Record<
  string,
  "default" | "accent" | "success" | "info" | "warning"
> = {
  BASIC: "default",
  PRO: "accent",
  STUDIO: "info",
  INCANTA: "warning",
};

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

export default function AdminDashboardPage() {
  useDocumentTitle("Admin · Dashboard");
  const { data: user, isLoading: userLoading } = api.user.me.useQuery();
  const { data: stats, isLoading } = api.admin.getStats.useQuery(undefined, {
    enabled: !!user?.checkpointAdmin,
  });

  if (!userLoading && !user?.checkpointAdmin) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Admin"
        description="Platform overview and management"
      />
      <AdminTabs />

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg bg-[var(--color-bg-secondary)]"
            />
          ))}
        </div>
      ) : stats ? (
        <div className="space-y-8">
          {/* Top-level stats */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Card>
              <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                {stats.totalUsers}
              </div>
              <div className="text-sm text-[var(--color-text-secondary)]">
                Users
              </div>
            </Card>
            <Card>
              <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                {stats.totalOrgs}
              </div>
              <div className="text-sm text-[var(--color-text-secondary)]">
                Organizations
              </div>
            </Card>
            <Card>
              <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                {stats.totalRepos}
              </div>
              <div className="text-sm text-[var(--color-text-secondary)]">
                Repositories
              </div>
            </Card>
          </div>

          {/* Subscription tiers */}
          <div>
            <h2 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
              Subscriptions by Tier
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {stats.tierCounts.map((t) => (
                <Card key={t.tier}>
                  <div className="flex items-center gap-2">
                    <Badge variant={TIER_COLORS[t.tier] ?? "default"}>
                      {t.tier}
                    </Badge>
                  </div>
                  <div className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">
                    {t.count}
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {/* Subscription statuses */}
          <div>
            <h2 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
              Subscriptions by Status
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {stats.statusCounts.map((s) => (
                <Card key={s.status}>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_COLORS[s.status] ?? "default"}>
                      {s.status}
                    </Badge>
                  </div>
                  <div className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">
                    {s.count}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
