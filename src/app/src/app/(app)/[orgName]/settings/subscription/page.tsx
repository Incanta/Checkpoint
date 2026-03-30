"use client";

import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader, Badge, Tabs, Tab } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { useLicenseTier } from "~/app/_hooks/use-license-tier";

const TIER_LABELS: Record<string, { label: string; color: "default" | "info" | "accent" | "warning" }> = {
  BASIC: { label: "Basic", color: "default" },
  PRO: { label: "Pro", color: "info" },
  STUDIO: { label: "Studio", color: "accent" },
  INCANTA: { label: "Incanta", color: "warning" },
};

const TIER_FEATURES: Record<string, string[]> = {
  BASIC: ["Checkouts & locking", "Branching", "All clients"],
  PRO: ["Pull requests & reviews", "Shelves", "Horde integration", "Artifacts"],
  STUDIO: ["Data replicas", "Enterprise SAML"],
  INCANTA: ["Custom enterprise features"],
};

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function OrgSubscriptionPage() {
  const params = useParams<{ orgName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  useDocumentTitle(`Subscription · ${orgName}`);
  const utils = api.useUtils();

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
    includeUsers: true,
  });

  const { tier, features, isLoading } = useLicenseTier(org?.id);

  const { data: activityData } = api.org.getOrgActivity.useQuery(
    { orgId: org?.id ?? "" },
    { enabled: !!org?.id },
  );

  // Check if user is admin/billing
  const { data: currentUser } = api.user.me.useQuery();
  const orgUser = ((org as Record<string, unknown> | undefined)?.users as Array<{ userId: string; role: string }> | undefined)?.find?.((u) => u.userId === currentUser?.id);
  const canManage = orgUser?.role === "ADMIN" || orgUser?.role === "BILLING";

  const updateSub = api.org.updateSubscription.useMutation({
    onSuccess: () => {
      void utils.org.getOrg.invalidate();
      void utils.license.getEffectiveTier.invalidate();
    },
  });

  const tierInfo = TIER_LABELS[tier] ?? TIER_LABELS.BASIC!;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`${orgName} subscription`}
        breadcrumbs={
          <span>
            <a href={`/${orgName}`} className="text-[var(--color-info)] hover:underline">
              {orgName}
            </a>
            {" / Settings / Subscription"}
          </span>
        }
      />

      <Tabs className="mb-6">
        <Tab href={`/${orgName}/settings`} exact>
          General
        </Tab>
        <Tab href={`/${orgName}/settings/members`}>Members</Tab>
        <Tab href={`/${orgName}/settings/subscription`}>Subscription</Tab>
      </Tabs>

      <div className="space-y-6">
        {/* Current plan */}
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Current plan
              </h3>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant={tierInfo.color}>{tierInfo.label}</Badge>
                {isLoading && (
                  <span className="text-xs text-[var(--color-text-muted)]">Loading...</span>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <h4 className="mb-2 text-xs font-medium uppercase text-[var(--color-text-muted)]">
              Included features
            </h4>
            <ul className="space-y-1 text-sm text-[var(--color-text-secondary)]">
              {/* Show all features up to and including the current tier */}
              {(["BASIC", "PRO", "STUDIO", "INCANTA"] as const).map((t) => {
                const tIdx = ["BASIC", "PRO", "STUDIO", "INCANTA"].indexOf(t);
                const currentIdx = ["BASIC", "PRO", "STUDIO", "INCANTA"].indexOf(tier);
                if (tIdx > currentIdx) return null;
                return (TIER_FEATURES[t] ?? []).map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <span className="text-[var(--color-success)]">✓</span> {f}
                  </li>
                ));
              })}
            </ul>
          </div>
        </Card>

        {/* Usage this month */}
        {activityData && (
          <Card>
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
              Usage — {MONTH_NAMES[activityData.summary.month]} {activityData.summary.year}
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-md bg-[var(--color-bg-tertiary)] p-3 text-center">
                <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                  {activityData.summary.totalActiveWriteUsers}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">Active Write Users</div>
              </div>
              <div className="rounded-md bg-[var(--color-bg-tertiary)] p-3 text-center">
                <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                  {activityData.summary.totalActiveReadUsers}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">Active Read Users</div>
              </div>
              <div className="rounded-md bg-[var(--color-bg-tertiary)] p-3 text-center">
                <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                  {activityData.summary.totalActiveUsers}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">Total Active</div>
              </div>
            </div>
          </Card>
        )}

        {/* Change plan (cloud admins only) */}
        {canManage && (
          <Card>
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
              Change plan
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {(["BASIC", "PRO", "STUDIO", "INCANTA"] as const).map((t) => {
                const info = TIER_LABELS[t]!;
                const isCurrent = t === tier;
                return (
                  <button
                    key={t}
                    disabled={isCurrent || updateSub.isPending}
                    onClick={() => org && updateSub.mutate({ orgId: org.id, tier: t })}
                    className={`rounded-md border p-3 text-left text-sm transition-colors ${
                      isCurrent
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                        : "border-[var(--color-border-default)] hover:border-[var(--color-accent)]/50"
                    } ${updateSub.isPending ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={info.color}>{info.label}</Badge>
                      {isCurrent && (
                        <span className="text-xs text-[var(--color-text-muted)]">Current</span>
                      )}
                    </div>
                    <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-text-secondary)]">
                      {(TIER_FEATURES[t] ?? []).map((f) => (
                        <li key={f}>• {f}</li>
                      ))}
                    </ul>
                  </button>
                );
              })}
            </div>
            {updateSub.error && (
              <p className="mt-2 text-sm text-[var(--color-danger)]">{updateSub.error.message}</p>
            )}
            {updateSub.isSuccess && (
              <p className="mt-2 text-sm text-[var(--color-success)]">Plan updated successfully.</p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
