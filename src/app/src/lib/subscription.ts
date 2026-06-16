import type { SubscriptionStatus } from "@prisma/client";

export type RestrictedSubscriptionStatus =
  | "PAST_DUE"
  | "CANCELED"
  | "SUSPENDED"
  | "DELETED"
  | "TRIAL_EXPIRED";

export function getRestrictedStatus(org: {
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
}): RestrictedSubscriptionStatus | null {
  switch (org.subscriptionStatus) {
    case "PAST_DUE":
    case "CANCELED":
    case "SUSPENDED":
    case "DELETED":
      return org.subscriptionStatus;
    case "TRIAL":
      if (org.trialEndsAt && org.trialEndsAt.getTime() <= Date.now()) {
        return "TRIAL_EXPIRED";
      }
      return null;
    default:
      return null;
  }
}

export const RESTRICTED_STATUS_LABELS: Record<
  RestrictedSubscriptionStatus,
  string
> = {
  PAST_DUE: "Past due",
  CANCELED: "Canceled",
  SUSPENDED: "Suspended",
  DELETED: "Deleted",
  TRIAL_EXPIRED: "Trial expired",
};

export const RESTRICTED_STATUS_MESSAGES: Record<
  RestrictedSubscriptionStatus,
  string
> = {
  PAST_DUE:
    "Payment is overdue. Repositories will be hidden until billing is resolved.",
  CANCELED:
    "The subscription has been canceled. Access will be permanently removed soon if not resumed.",
  SUSPENDED:
    "Access is suspended due to unpaid invoices. Resume the subscription to restore access.",
  DELETED:
    "Organization data has been deleted due to unpaid invoices.",
  TRIAL_EXPIRED:
    "The free trial has ended. Start a subscription to restore access.",
};
