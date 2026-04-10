"use client";

import { useState } from "react";
import { useParams, notFound } from "next/navigation";
import { api } from "~/trpc/react";
import {
  Button,
  Card,
  PageHeader,
  Badge,
} from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { useLicenseTier } from "~/app/_hooks/use-license-tier";
import { SettingsTabs } from "../_components/settings-tabs";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const STATUS_BADGE: Record<
  string,
  {
    label: string;
    variant: "default" | "accent" | "success" | "danger" | "warning" | "info";
  }
> = {
  ACTIVE: { label: "Active", variant: "success" },
  TRIAL: { label: "Trial", variant: "info" },
  PAST_DUE: { label: "Past Due", variant: "warning" },
  SUSPENDED: { label: "Suspended", variant: "danger" },
  CANCELED: { label: "Canceled", variant: "default" },
  DELETED: { label: "Deleted", variant: "danger" },
};

const INVOICE_STATUS_BADGE: Record<
  string,
  {
    label: string;
    variant: "default" | "success" | "danger" | "warning" | "info";
  }
> = {
  DRAFT: { label: "Draft", variant: "default" },
  ISSUED: { label: "Issued", variant: "info" },
  PAID: { label: "Paid", variant: "success" },
  FAILED: { label: "Failed", variant: "danger" },
  HELD: { label: "Held", variant: "warning" },
  VOID: { label: "Void", variant: "default" },
};

const TIER_LABELS: Record<
  string,
  { label: string; color: "default" | "info" | "accent" }
> = {
  BASIC: { label: "Basic", color: "default" },
  PRO: { label: "Pro", color: "info" },
  STUDIO: { label: "Studio", color: "accent" },
};

const TIER_FEATURES: Record<string, string[]> = {
  BASIC: ["Checkouts & locking", "Branching", "All clients"],
  PRO: ["Pull requests & reviews", "Shelves", "Horde integration", "Artifacts"],
  STUDIO: ["Data replicas", "Enterprise SAML"],
};

const TIER_PRICING: Record<string, { write: number; read: number | string }> = {
  BASIC: { write: 3, read: "1.50" },
  PRO: { write: 6, read: 3 },
  STUDIO: { write: 14, read: 7 },
};

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function Modal({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-6 shadow-xl">
        {children}
      </div>
    </div>
  );
}

export default function BillingPage() {
  const params = useParams<{ orgName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  useDocumentTitle(`Billing · ${orgName}`);
  const utils = api.useUtils();

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
    includeUsers: true,
  });

  const { tier, isLoading: tierLoading } = useLicenseTier(org?.id);
  const tierInfo = TIER_LABELS[tier] ?? TIER_LABELS.BASIC!;

  const { data: activityData } = api.org.getOrgActivity.useQuery(
    { orgId: org?.id ?? "" },
    { enabled: !!org?.id },
  );

  const { data: billing, isLoading: billingLoading } =
    api.billing.getBillingInfo.useQuery(
      { orgId: org?.id ?? "" },
      { enabled: !!org?.id },
    );

  const {
    data: invoiceData,
    fetchNextPage,
    hasNextPage,
  } = api.billing.getInvoices.useInfiniteQuery(
    { orgId: org?.id ?? "", limit: 10 },
    {
      enabled: !!org?.id,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const { data: checkoutSettings } = api.billing.getCheckoutSettings.useQuery();

  const { data: currentUser } = api.user.me.useQuery();
  const orgUser = (
    (org as Record<string, unknown> | undefined)?.users as
      | Array<{ userId: string; role: string }>
      | undefined
  )?.find?.((u) => u.userId === currentUser?.id);
  const canManage = orgUser?.role === "ADMIN" || orgUser?.role === "BILLING";

  const [showChangePlan, setShowChangePlan] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showResumeConfirm, setShowResumeConfirm] = useState(false);
  const [selectedTier, setSelectedTier] = useState<"BASIC" | "PRO" | "STUDIO">(
    "BASIC",
  );

  const cancelSub = api.billing.cancelSubscription.useMutation({
    onSuccess: () => {
      setShowCancelConfirm(false);
      void utils.billing.getBillingInfo.invalidate();
    },
  });

  const resumeSub = api.billing.resumeSubscription.useMutation({
    onSuccess: () => {
      setShowResumeConfirm(false);
      void utils.billing.getBillingInfo.invalidate();
    },
  });

  const changeTier = api.billing.changeTier.useMutation({
    onSuccess: () => {
      setShowChangePlan(false);
      void utils.billing.getBillingInfo.invalidate();
      void utils.license.getEffectiveTier.invalidate();
    },
  });

  const cancelScheduled = api.billing.cancelScheduledChange.useMutation({
    onSuccess: () => {
      void utils.billing.getBillingInfo.invalidate();
    },
  });

  if (checkoutSettings && !checkoutSettings.enabled) {
    notFound();
  }

  const tierOrder = { BASIC: 0, PRO: 1, STUDIO: 2 } as Record<string, number>;
  const isDowngrade =
    (tierOrder[selectedTier] ?? 0) < (tierOrder[billing?.tier ?? ""] ?? 0);
  const isTrial = billing?.status === "TRIAL";

  const statusInfo = billing
    ? (STATUS_BADGE[billing.status ?? ""] ?? STATUS_BADGE.ACTIVE!)
    : STATUS_BADGE.ACTIVE!;

  const allInvoices = invoiceData?.pages.flatMap((p) => p.invoices) ?? [];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`${orgName} billing`}
        breadcrumbs={
          <span>
            <a
              href={`/${orgName}`}
              className="text-[var(--color-info)] hover:underline"
            >
              {orgName}
            </a>
            {" / Settings / Billing"}
          </span>
        }
      />

      <SettingsTabs orgName={orgName} />

      <div className="space-y-6">
        {/* Current Plan */}
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Current Plan
              </h3>
              <div className="mt-1 flex items-center gap-2">
                {billing && (
                  <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                )}
                <Badge variant={tierInfo.color}>{tierInfo.label}</Badge>
                {tierLoading && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    Loading...
                  </span>
                )}
              </div>
            </div>

            {canManage && billing && (
              <div>
                {(billing.status === "PAST_DUE" ||
                  billing.status === "SUSPENDED" ||
                  billing.status === "CANCELED" ||
                  (billing.status === "TRIAL" && billing.canceledAt)) && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setShowResumeConfirm(true)}
                  >
                    Resume Subscription
                  </Button>
                )}
              </div>
            )}
          </div>

          {billing?.trialEndsAt && !billing.canceledAt && (
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              Trial ends: {formatDate(billing.trialEndsAt)}
            </p>
          )}
          {billing?.delinquentSince && (
            <p className="mt-2 text-sm text-[var(--color-danger)]">
              Payment overdue since {formatDate(billing.delinquentSince)}
            </p>
          )}

          {/* Scheduled tier change */}
          {billing?.scheduledTier && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-[var(--color-info)]/30 bg-[var(--color-info)]/5 px-3 py-2">
              <span className="text-sm text-[var(--color-text-secondary)]">
                Changing to{" "}
                <Badge
                  variant={
                    TIER_LABELS[billing.scheduledTier]?.color ?? "default"
                  }
                >
                  {TIER_LABELS[billing.scheduledTier]?.label ??
                    billing.scheduledTier}
                </Badge>{" "}
                {billing.scheduledTierAt
                  ? `on ${formatDate(billing.scheduledTierAt)}`
                  : "at end of billing period"}
              </span>
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancelScheduled.isPending}
                  onClick={() =>
                    org && cancelScheduled.mutate({ orgId: org.id })
                  }
                >
                  {cancelScheduled.isPending ? "..." : "Undo"}
                </Button>
              )}
            </div>
          )}

          {/* Cancellation pending */}
          {billing?.canceledAt &&
            (billing.status === "TRIAL" ? (
              <div className="mt-2 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2">
                <p className="text-sm text-[var(--color-danger)]">
                  Cancellation scheduled. Your trial continues until{" "}
                  <strong>
                    {billing.trialEndsAt
                      ? formatDate(billing.trialEndsAt)
                      : "the end of the trial period"}
                  </strong>
                  , after which your organization will be suspended.
                </p>
              </div>
            ) : billing.currentPeriodEnd ? (
              <div className="mt-2 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2">
                <p className="text-sm text-[var(--color-danger)]">
                  Your plan will be canceled on{" "}
                  {formatDate(billing.currentPeriodEnd)}. Access continues until
                  then.
                </p>
              </div>
            ) : null)}

          {resumeSub.error && (
            <p className="mt-2 text-sm text-[var(--color-danger)]">
              {resumeSub.error.message}
            </p>
          )}

          {/* Included features */}
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-medium uppercase text-[var(--color-text-muted)]">
              Included features
            </h4>
            <ul className="space-y-1 text-sm text-[var(--color-text-secondary)]">
              {(["BASIC", "PRO", "STUDIO"] as const).map((t) => {
                const tIdx = ["BASIC", "PRO", "STUDIO"].indexOf(t);
                const currentIdx = ["BASIC", "PRO", "STUDIO"].indexOf(tier);
                if (tIdx > currentIdx) return null;
                return (TIER_FEATURES[t] ?? []).map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <span className="text-[var(--color-success)]">✓</span> {f}
                  </li>
                ));
              })}
            </ul>
          </div>

          {/* Action Buttons */}
          {canManage &&
            billing &&
            !billing.canceledAt &&
            (billing.status === "ACTIVE" || billing.status === "TRIAL") && (
              <div className="mt-4 flex gap-2 border-t border-[var(--color-border-default)] pt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSelectedTier(
                      (billing.tier as "BASIC" | "PRO" | "STUDIO") ?? "BASIC",
                    );
                    setShowChangePlan(true);
                  }}
                >
                  Change Plan
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setShowCancelConfirm(true)}
                >
                  Cancel Plan
                </Button>
              </div>
            )}
        </Card>

        {/* Usage this month */}
        {activityData && (
          <Card>
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
              Usage — {MONTH_NAMES[activityData.summary.month]}{" "}
              {activityData.summary.year}
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-md bg-[var(--color-bg-tertiary)] p-3 text-center">
                <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                  {activityData.summary.totalActiveWriteUsers}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Active Write Users
                </div>
              </div>
              <div className="rounded-md bg-[var(--color-bg-tertiary)] p-3 text-center">
                <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                  {activityData.summary.totalActiveReadUsers}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Active Read Users
                </div>
              </div>
              <div className="rounded-md bg-[var(--color-bg-tertiary)] p-3 text-center">
                <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                  {activityData.summary.totalActiveUsers}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Total Active
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Credits */}
        {billing && billing.creditBalanceCents > 0 && (
          <Card>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Credit Balance
            </h3>
            <p className="mt-1 text-2xl font-bold text-[var(--color-success)]">
              {formatCents(billing.creditBalanceCents)}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Credits are automatically applied to your next invoice.
            </p>
          </Card>
        )}

        {/* Invoice History */}
        <Card>
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
              Invoice History
            </h3>
            {billingLoading ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Loading...
              </p>
            ) : allInvoices.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No invoices yet.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-2 text-xs font-medium uppercase text-[var(--color-text-muted)]">
                  <div>Period</div>
                  <div>Amount</div>
                  <div>Status</div>
                  <div>Date</div>
                </div>
                {allInvoices.map((inv) => {
                  const invStatus =
                    INVOICE_STATUS_BADGE[inv.status] ??
                    INVOICE_STATUS_BADGE.DRAFT!;
                  return (
                    <div
                      key={inv.id}
                      className="grid grid-cols-4 gap-2 border-t border-[var(--color-border-default)] py-2 text-sm"
                    >
                      <div className="text-[var(--color-text-primary)]">
                        {inv.month}/{inv.year}
                      </div>
                      <div className="text-[var(--color-text-primary)]">
                        {formatCents(inv.totalCents)}
                      </div>
                      <div>
                        <Badge variant={invStatus.variant}>
                          {invStatus.label}
                        </Badge>
                      </div>
                      <div className="text-[var(--color-text-muted)]">
                        {formatDate(
                          (inv.paidAt ??
                            inv.issuedAt ??
                            inv.createdAt) as unknown as string,
                        )}
                      </div>
                    </div>
                  );
                })}
                {hasNextPage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void fetchNextPage()}
                    className="mt-2"
                  >
                    Load more
                  </Button>
                )}
              </div>
            )}
          </Card>
      </div>

      {/* Change Plan Modal */}
      <Modal open={showChangePlan} onClose={() => setShowChangePlan(false)}>
        <h3 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
          Change Plan
        </h3>
        <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
          {isDowngrade && !isTrial
            ? "Select a new plan. Downgrades take effect at the end of your current billing period — you'll keep your current features until then."
            : "Select a new plan. Your subscription will be updated immediately."}
        </p>

        <div className="grid grid-cols-3 items-start gap-3">
          {(["BASIC", "PRO", "STUDIO"] as const).map((t) => {
            const pricing = TIER_PRICING[t]!;
            const isCurrent = billing?.tier === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setSelectedTier(t)}
                disabled={isCurrent}
                className={`rounded-md border p-4 text-left text-sm transition-colors ${
                  selectedTier === t && !isCurrent
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                    : isCurrent
                      ? "border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] opacity-60"
                      : "border-[var(--color-border-default)] hover:border-[var(--color-accent)]/50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      t === "STUDIO"
                        ? "accent"
                        : t === "PRO"
                          ? "info"
                          : "default"
                    }
                  >
                    {t}
                  </Badge>
                  {isCurrent && (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      Current
                    </span>
                  )}
                </div>

                <div className="mt-3 space-y-0.5">
                  <p className="text-lg font-bold text-[var(--color-text-primary)]">
                    ${pricing.write}
                    <span className="text-xs font-normal text-[var(--color-text-muted)]">
                      /write user/mo
                    </span>
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    ${pricing.read}/read user/mo
                  </p>
                </div>

                <ul className="mt-3 space-y-0.5 text-xs text-[var(--color-text-secondary)]">
                  {(TIER_FEATURES[t] ?? []).map((f) => (
                    <li key={f}>• {f}</li>
                  ))}
                  {t !== "BASIC" && (
                    <li className="text-[var(--color-text-muted)]">
                      + all {t === "STUDIO" ? "Pro" : "Basic"} features
                    </li>
                  )}
                </ul>
              </button>
            );
          })}
        </div>

        {isDowngrade && !isTrial && billing?.currentPeriodEnd && (
          <p className="mt-3 rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 px-3 py-2 text-sm text-[var(--color-text-secondary)]">
            Your plan will change to{" "}
            <strong>{TIER_LABELS[selectedTier]?.label ?? selectedTier}</strong>{" "}
            on <strong>{formatDate(billing.currentPeriodEnd)}</strong>.
          </p>
        )}

        {changeTier.error && (
          <p className="mt-3 text-sm text-[var(--color-danger)]">
            {changeTier.error.message}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setShowChangePlan(false)}>
            Cancel
          </Button>
          <Button
            disabled={changeTier.isPending || selectedTier === billing?.tier}
            onClick={() => {
              if (org) {
                changeTier.mutate({ orgId: org.id, tier: selectedTier });
              }
            }}
          >
            {changeTier.isPending
              ? "Updating..."
              : isDowngrade && !isTrial
                ? `Schedule downgrade to ${selectedTier}`
                : `Switch to ${selectedTier}`}
          </Button>
        </div>
      </Modal>

      {/* Cancel Plan Modal */}
      <Modal
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
      >
        <h3 className="mb-2 text-lg font-semibold text-[var(--color-danger)]">
          Cancel your plan?
        </h3>

        <div className="space-y-3 text-sm text-[var(--color-text-secondary)]">
          {billing?.status === "TRIAL" ? (
            <>
              <p>
                Your trial will continue until{" "}
                <strong>
                  {billing.trialEndsAt
                    ? formatDate(billing.trialEndsAt)
                    : "the end of the trial period"}
                </strong>
                . After that:
              </p>
              <ul className="ml-4 list-disc space-y-1">
                <li>
                  Your organization will lose access to Checkpoint immediately.
                </li>
                <li>
                  Any outstanding invoices will be held and due if you
                  resubscribe.
                </li>
                <li>
                  You have{" "}
                  <strong>
                    2 weeks after{" "}
                    {billing.trialEndsAt
                      ? formatDate(billing.trialEndsAt)
                      : "the end of the trial period"}
                  </strong>{" "}
                  to resume your subscription before your data is{" "}
                  <strong>permanently deleted</strong>.
                </li>
              </ul>
            </>
          ) : (
            <>
              <p>
                No changes will be made until the end of your current billing
                period
                {billing?.currentPeriodEnd && (
                  <>
                    {" "}
                    on <strong>{formatDate(billing.currentPeriodEnd)}</strong>
                  </>
                )}
                . If you cancel:
              </p>
              <ul className="ml-4 list-disc space-y-1">
                <li>
                  You&apos;ll keep full access to your current plan until{" "}
                  {billing?.currentPeriodEnd ? (
                    <strong>{formatDate(billing.currentPeriodEnd)}</strong>
                  ) : (
                    "the end of the billing period"
                  )}
                  .
                </li>
                <li>
                  After that, your organization will be suspended and members
                  will lose access.
                </li>
                <li>
                  You have <strong>2 weeks</strong> after suspension to resume
                  your subscription before data is permanently deleted.
                </li>
                <li>
                  Any pending invoices will still be charged to your payment
                  method.
                </li>
              </ul>
            </>
          )}
        </div>

        {cancelSub.error && (
          <p className="mt-3 text-sm text-[var(--color-danger)]">
            {cancelSub.error.message}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => setShowCancelConfirm(false)}
          >
            Keep Plan
          </Button>
          <Button
            variant="danger"
            disabled={cancelSub.isPending}
            onClick={() => {
              if (org) {
                cancelSub.mutate({ orgId: org.id });
              }
            }}
          >
            {cancelSub.isPending ? "Canceling..." : "Confirm Cancellation"}
          </Button>
        </div>
      </Modal>

      {/* Resume Subscription Modal */}
      <Modal
        open={showResumeConfirm}
        onClose={() => setShowResumeConfirm(false)}
      >
        <h3 className="mb-2 text-lg font-semibold text-[var(--color-text-primary)]">
          Resume your subscription?
        </h3>

        <div className="space-y-3 text-sm text-[var(--color-text-secondary)]">
          {billing?.status === "TRIAL" ? (
            <p>
              Your trial cancellation will be undone and your trial will
              continue until{" "}
              <strong>
                {billing.trialEndsAt
                  ? formatDate(billing.trialEndsAt)
                  : "the end of the trial period"}
              </strong>
              . After the trial, your subscription will begin normally.
            </p>
          ) : (
            <>
              <p>Your subscription will be reactivated immediately.</p>
              <ul className="ml-4 list-disc space-y-1">
                <li>
                  Access will be restored for all members of your organization.
                </li>
                <li>
                  Any outstanding invoices will be retried against your payment
                  method.
                </li>
              </ul>
            </>
          )}
        </div>

        {resumeSub.error && (
          <p className="mt-3 text-sm text-[var(--color-danger)]">
            {resumeSub.error.message}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => setShowResumeConfirm(false)}
          >
            Go Back
          </Button>
          <Button
            disabled={resumeSub.isPending}
            onClick={() => {
              if (org) {
                resumeSub.mutate({ orgId: org.id });
              }
            }}
          >
            {resumeSub.isPending ? "Resuming..." : "Confirm Resume"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
