import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import {
  getTrialDurationDays,
  getStripeClient,
  isStripeEnabled,
} from "../stripe/client";

/**
 * Start a free trial for an org.
 * - Validates the user hasn't already used their trial
 * - Sets org to TRIAL status with trialEndsAt
 * - Marks user.trialUsed = true
 */
export async function startTrial(
  orgId: string,
  userId: string,
  db: PrismaClient,
): Promise<{ success: boolean; trialEndsAt: Date | null; error?: string }> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { trialUsed: true },
  });

  if (user.trialUsed) {
    return {
      success: false,
      trialEndsAt: null,
      error: "You have already used your free trial",
    };
  }

  const durationDays = getTrialDurationDays();
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + durationDays);

  await db.$transaction([
    db.org.update({
      where: { id: orgId },
      data: {
        subscriptionStatus: "TRIAL",
        subscriptionTier: "BASIC",
        trialEndsAt,
      },
    }),
    db.user.update({
      where: { id: userId },
      data: { trialUsed: true },
    }),
  ]);

  Logger.info(
    `[Billing] Trial started for org ${orgId} by user ${userId}, ends ${trialEndsAt.toISOString()}`,
  );

  return { success: true, trialEndsAt };
}

/**
 * Cancel a trial (user cancels before trial period ends).
 * Access continues until trialEndsAt, then org becomes SUSPENDED.
 * Outstanding invoices are held.
 */
export async function cancelTrial(
  orgId: string,
  db: PrismaClient,
): Promise<void> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { subscriptionStatus: true, stripeSubscriptionId: true },
  });

  if (org.subscriptionStatus !== "TRIAL") {
    throw new Error("Org is not in trial status");
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

  // Hold any pending invoices
  await db.invoice.updateMany({
    where: {
      orgId,
      status: { in: ["DRAFT", "ISSUED"] },
    },
    data: { status: "HELD", heldAt: new Date() },
  });

  await db.org.update({
    where: { id: orgId },
    data: { canceledAt: new Date() },
  });

  Logger.info(`[Billing] Trial canceled for org ${orgId}`);
}

/**
 * Check if a trial has expired and transition the org status.
 * Called by the daily scheduler.
 *
 * If trial ended and not canceled → ACTIVE (normal billing starts)
 * If trial ended and canceled → SUSPENDED (delinquent)
 */
export async function checkTrialExpiry(db: PrismaClient): Promise<void> {
  const now = new Date();

  // Trials that ended without cancellation → transition to ACTIVE
  const expiredActive = await db.org.findMany({
    where: {
      subscriptionStatus: "TRIAL",
      canceledAt: null,
      trialEndsAt: { lte: now },
      deletedAt: null,
    },
    select: { id: true, name: true },
  });

  for (const org of expiredActive) {
    await db.org.update({
      where: { id: org.id },
      data: { subscriptionStatus: "ACTIVE" },
    });
    Logger.info(
      `[Billing] Trial ended for org ${org.name} (${org.id}) — transitioned to ACTIVE`,
    );
  }

  // Trials that ended AND were canceled → SUSPENDED
  const expiredCanceled = await db.org.findMany({
    where: {
      subscriptionStatus: "TRIAL",
      canceledAt: { not: null },
      trialEndsAt: { lte: now },
      deletedAt: null,
    },
    select: { id: true, name: true },
  });

  for (const org of expiredCanceled) {
    await db.org.update({
      where: { id: org.id },
      data: {
        subscriptionStatus: "SUSPENDED",
        suspendedAt: now,
        delinquentSince: now,
      },
    });
    Logger.info(
      `[Billing] Trial ended (canceled) for org ${org.name} (${org.id}) — SUSPENDED`,
    );
  }
}
