import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import { TimeManager } from "../time";
import {
  getDelinquencyConfig,
  getStripeClient,
  isStripeEnabled,
} from "../stripe/client";
import { sendEmail } from "../email/service";
import {
  accountSuspendedEmail,
  accountDeletionWarningEmail,
} from "../email/billing-templates";

/**
 * Mark an org as delinquent after a payment failure.
 * Called from the webhook handler.
 */
export async function markDelinquent(
  orgId: string,
  db: PrismaClient,
): Promise<void> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { subscriptionStatus: true, delinquentSince: true, name: true },
  });

  // Only set delinquentSince if not already set
  if (!org.delinquentSince) {
    await db.org.update({
      where: { id: orgId },
      data: {
        subscriptionStatus: "PAST_DUE",
        delinquentSince: TimeManager.date(),
      },
    });
    Logger.warn(`[Billing] Org ${org.name} (${orgId}) marked PAST_DUE`);
  }
}

/**
 * Daily delinquency check. For each delinquent org:
 * - Suspend after configurable days
 * - Mark for deletion after configurable days
 * Sends notification emails at each transition.
 */
export async function checkDelinquency(db: PrismaClient): Promise<void> {
  const { suspendAfterDays, deleteAfterDays } = getDelinquencyConfig();
  const now = TimeManager.date();

  const suspendThreshold = new Date(now);
  suspendThreshold.setDate(suspendThreshold.getDate() - suspendAfterDays);

  const deleteThreshold = new Date(now);
  deleteThreshold.setDate(deleteThreshold.getDate() - deleteAfterDays);

  // Find orgs that should be suspended (PAST_DUE for > suspendAfterDays)
  const toSuspend = await db.org.findMany({
    where: {
      subscriptionStatus: "PAST_DUE",
      delinquentSince: { lte: suspendThreshold },
      deletedAt: null,
    },
    select: { id: true, name: true },
  });

  for (const org of toSuspend) {
    await db.org.update({
      where: { id: org.id },
      data: {
        subscriptionStatus: "SUSPENDED",
        suspendedAt: now,
      },
    });

    // Notify admins
    await notifyOrgAdmins(org.id, org.name, "suspended", db);
    Logger.warn(`[Billing] Org ${org.name} (${org.id}) SUSPENDED`);
  }

  // Find orgs that should be marked for deletion (delinquent > deleteAfterDays)
  const toDelete = await db.org.findMany({
    where: {
      subscriptionStatus: "SUSPENDED",
      delinquentSince: { lte: deleteThreshold },
      deletedAt: null,
    },
    select: { id: true, name: true },
  });

  for (const org of toDelete) {
    await db.org.update({
      where: { id: org.id },
      data: { subscriptionStatus: "DELETED" },
    });

    // NOTE: for now, we do not automatically delete data after marking DELETED.
    // This allows Checkpoint operators to determine if/when the data gets deleted.

    // Notify admins before deletion
    await notifyOrgAdmins(org.id, org.name, "deletion", db);
    Logger.warn(`[Billing] Org ${org.name} (${org.id}) marked DELETED`);
  }
}

/**
 * Resume a suspended or past-due org.
 * Charges any held/failed invoices and restores ACTIVE status.
 */
export async function resumeSubscription(
  orgId: string,
  db: PrismaClient,
): Promise<{ success: boolean; error?: string }> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: {
      subscriptionStatus: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      canceledAt: true,
    },
  });

  const isCanceledTrial =
    org.subscriptionStatus === "TRIAL" && !!org.canceledAt;

  if (
    !isCanceledTrial &&
    !["PAST_DUE", "SUSPENDED", "CANCELED"].includes(org.subscriptionStatus)
  ) {
    return { success: false, error: "Org is not in a resumable state" };
  }

  // Reactivate Stripe subscription if it was canceled
  if (isStripeEnabled() && org.stripeSubscriptionId) {
    try {
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);

      if (sub.cancel_at_period_end) {
        await stripe.subscriptions.update(org.stripeSubscriptionId, {
          cancel_at_period_end: false,
        });
      }

      if (!isCanceledTrial) {
        // Retry any open invoices (not needed for trial resume)
        const openInvoices = await stripe.invoices.list({
          customer: org.stripeCustomerId ?? undefined,
          status: "open",
          limit: 10,
        });

        for (const inv of openInvoices.data) {
          try {
            await stripe.invoices.pay(inv.id);
          } catch (err: any) {
            Logger.warn(
              `[Billing] Failed to retry Stripe invoice ${inv.id}: ${JSON.stringify(err)}`,
            );
          }
        }
      }
    } catch (err: any) {
      Logger.error(
        `[Billing] Failed to reactivate Stripe subscription for org ${orgId}: ${JSON.stringify(err)}`,
      );
      return {
        success: false,
        error: "Failed to reactivate subscription. Please try again.",
      };
    }
  }

  if (isCanceledTrial) {
    // Resume trial — keep TRIAL status, just clear canceledAt
    await db.org.update({
      where: { id: orgId },
      data: {
        canceledAt: null,
        scheduledTier: null,
        scheduledTierAt: null,
      },
    });

    Logger.info(`[Billing] Trial cancellation undone for org ${orgId}`);
  } else {
    // Restore ACTIVE status
    await db.org.update({
      where: { id: orgId },
      data: {
        subscriptionStatus: "ACTIVE",
        canceledAt: null,
        suspendedAt: null,
        delinquentSince: null,
        scheduledTier: null,
        scheduledTierAt: null,
      },
    });

    Logger.info(`[Billing] Subscription resumed for org ${orgId}`);
  }

  return { success: true };
}

/**
 * Cancel a subscription. Access continues until the end of the current
 * billing period (end of month). Future invoices are held.
 */
export async function cancelSubscription(
  orgId: string,
  db: PrismaClient,
): Promise<void> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { subscriptionStatus: true, stripeSubscriptionId: true },
  });

  if (
    org.subscriptionStatus !== "TRIAL" &&
    org.subscriptionStatus !== "ACTIVE"
  ) {
    throw new Error(`Cannot cancel org in ${org.subscriptionStatus} status`);
  }

  // Cancel Stripe subscription at period end
  if (isStripeEnabled() && org.stripeSubscriptionId) {
    try {
      const stripe = getStripeClient();
      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    } catch (err: any) {
      Logger.warn(
        `[Billing] Failed to cancel Stripe subscription for org ${orgId}: ${JSON.stringify(err)}`,
      );
    }
  }

  await db.org.update({
    where: { id: orgId },
    data: {
      subscriptionStatus:
        org.subscriptionStatus === "TRIAL" ? "TRIAL" : "CANCELED",
      canceledAt: TimeManager.date(),
    },
  });

  Logger.info(`[Billing] Subscription canceled for org ${orgId}`);
}

/** Send notification emails to all ADMIN and BILLING users of an org. */
async function notifyOrgAdmins(
  orgId: string,
  orgName: string,
  type: "suspended" | "deletion",
  db: PrismaClient,
): Promise<void> {
  const admins = await db.orgUser.findMany({
    where: {
      orgId,
      role: { in: ["ADMIN", "BILLING"] },
    },
    include: { user: { select: { email: true } } },
  });

  for (const admin of admins) {
    try {
      const template =
        type === "suspended"
          ? accountSuspendedEmail(orgName, `/${orgName}/settings/billing`)
          : accountDeletionWarningEmail(
              orgName,
              0,
              `/${orgName}/settings/billing`,
            );

      await sendEmail({
        to: admin.user.email,
        ...template,
      });
    } catch (err: any) {
      Logger.warn(
        `[Billing] Failed to send ${type} email to ${admin.user.email}: ${JSON.stringify(err)}`,
      );
    }
  }

  const checkpointAdmins = await db.user.findMany({
    where: { checkpointAdmin: true },
    select: { email: true },
  });

  for (const admin of checkpointAdmins) {
    try {
      const template =
        type === "suspended"
          ? accountSuspendedEmail(orgName, "/admin/billing")
          : accountDeletionWarningEmail(orgName, 0, "/admin/billing");

      await sendEmail({
        to: admin.email,
        ...template,
      });
    } catch (err: any) {
      Logger.warn(
        `[Billing] Failed to send ${type} email to Checkpoint admin ${admin.email}: ${JSON.stringify(err)}`,
      );
    }
  }
}
