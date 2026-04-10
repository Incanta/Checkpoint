"use client";

import { usePathname } from "next/navigation";
import { api } from "~/trpc/react";

export function BillingBanner() {
  const pathname = usePathname();

  // Extract orgName from path like /orgName/...
  const orgName = pathname.split("/")[1];

  const { data: checkoutSettings } = api.billing.getCheckoutSettings.useQuery();

  const { data: org } = api.org.getOrg.useQuery(
    { id: orgName ?? "", idIsName: true },
    { enabled: !!orgName && !!checkoutSettings?.enabled },
  );

  const { data: billing } = api.billing.getBillingInfo.useQuery(
    {
      orgId: ((org as Record<string, unknown> | undefined)?.id as string) ?? "",
    },
    {
      enabled:
        !!(org as Record<string, unknown> | undefined)?.id &&
        !!checkoutSettings?.enabled,
    },
  );

  if (!checkoutSettings?.enabled || !billing) return null;

  const status = billing.status;

  if (status === "ACTIVE" || status === "TRIAL") return null;

  const bannerConfig: Record<
    string,
    { bg: string; text: string; message: string } | undefined
  > = {
    PAST_DUE: {
      bg: "bg-[var(--color-warning)]/10",
      text: "text-[var(--color-warning)]",
      message:
        "Payment overdue — please update your payment method to avoid service interruption.",
    },
    SUSPENDED: {
      bg: "bg-[var(--color-danger)]/10",
      text: "text-[var(--color-danger)]",
      message:
        "Account suspended — resume your subscription to restore access.",
    },
    CANCELED: {
      bg: "bg-[var(--color-text-muted)]/10",
      text: "text-[var(--color-text-muted)]",
      message: "Subscription canceled — your access will end soon.",
    },
    DELETED: {
      bg: "bg-[var(--color-danger)]/10",
      text: "text-[var(--color-danger)]",
      message:
        "Account deleted — data removal is pending. Contact support if this is an error.",
    },
  };

  const config = bannerConfig[status ?? ""];
  if (!config) return null;

  return (
    <div
      className={`${config.bg} border-b border-[var(--color-border-default)] px-4 py-2`}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <p className={`text-sm ${config.text}`}>{config.message}</p>
        {orgName && (status === "PAST_DUE" || status === "SUSPENDED") && (
          <a
            href={`/${orgName}/settings/billing`}
            className="text-sm font-medium text-[var(--color-accent)] hover:underline"
          >
            Manage billing →
          </a>
        )}
      </div>
    </div>
  );
}
