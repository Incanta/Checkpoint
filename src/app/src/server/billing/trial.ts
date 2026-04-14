import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import { TimeManager } from "../time";
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
  tier: "BASIC" | "PRO" | "STUDIO" = "BASIC",
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
  const trialEndsAt = TimeManager.date();
  trialEndsAt.setDate(trialEndsAt.getDate() + durationDays);

  await db.$transaction([
    db.org.update({
      where: { id: orgId },
      data: {
        subscriptionStatus: "TRIAL",
        subscriptionTier: tier,
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
 * Check if a trial has expired and transition the org status.
 * Called by the daily scheduler.
 *
 * If trial ended and not canceled → ACTIVE (normal billing starts)
 * If trial ended and canceled → SUSPENDED (delinquent)
 */
export async function checkTrialExpiry(db: PrismaClient): Promise<void> {
  const now = TimeManager.date();

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

  await db.org.updateMany({
    where: {
      id: {
        in: expiredActive.map((o) => o.id),
      },
    },
    data: { subscriptionStatus: "ACTIVE" },
  });

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

  await db.org.updateMany({
    where: {
      id: {
        in: expiredCanceled.map((o) => o.id),
      },
    },
    data: {
      subscriptionStatus: "SUSPENDED",
      suspendedAt: now,
      delinquentSince: now,
    },
  });
}
