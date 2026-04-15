import "server-only";

import { Logger } from "../logging";
import { TimeManager } from "../time";
import {
  isStripeEnabled,
  getCardExpiryNotifyDays,
  getStripeClient,
} from "../stripe/client";
import { checkTrialExpiry } from "./trial";
import { checkDelinquency } from "./delinquency";
import { calculateStorageCharge } from "./storage-usage";
import { isR2Enabled, deleteR2Bucket } from "~/server/r2-service";
import { reportOrgMeters } from "./meter-reporting";
import { sendEmail } from "../email/service";
import {
  cardExpiryEmail,
  trialEndingEmail,
  trialChargeWarningEmail,
} from "../email/billing-templates";
import { type PrismaClient } from "@prisma/client";

// Track the last run dates to prevent duplicate runs
const SCHEDULER_STATE_KEY = Symbol.for("checkpoint.billing.scheduler");

interface SchedulerState {
  lastDailyRun: string | null; // "YYYY-MM-DD" of last daily check
  intervalId: ReturnType<typeof setInterval> | null;
}

const globalForScheduler = globalThis as unknown as {
  [SCHEDULER_STATE_KEY]?: SchedulerState;
};

/** Get current scheduler state (exported for dev tooling). */
export function getSchedulerState(): SchedulerState {
  if (!globalForScheduler[SCHEDULER_STATE_KEY]) {
    globalForScheduler[SCHEDULER_STATE_KEY] = {
      lastDailyRun: null,
      intervalId: null,
    };
  }
  return globalForScheduler[SCHEDULER_STATE_KEY];
}

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const METER_BATCH_SIZE = 10;
const METER_BATCH_DELAY_MS = 1000; // 1 second between batches

/**
 * Initialize the billing scheduler.
 * Checks every hour:
 * - Report meter events to Stripe (staggered batches)
 * - Daily: check trial expiry, delinquency, card expiry
 */
export function initBillingScheduler(): void {
  if (!isStripeEnabled()) {
    Logger.debug("[Billing] Stripe not enabled — scheduler not started");
    return;
  }

  const state = getSchedulerState();
  if (state.intervalId) {
    Logger.debug("[Billing] Scheduler already running");
    return;
  }

  Logger.info("[Billing] Starting billing scheduler");

  // Run immediately on startup
  void runSchedulerTick();

  state.intervalId = setInterval(() => {
    void runSchedulerTick();
  }, CHECK_INTERVAL_MS);
}

async function runSchedulerTick(): Promise<void> {
  const now = TimeManager.date();
  const state = getSchedulerState();
  const todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

  try {
    // Hourly: report all meters to Stripe (staggered)
    await reportMeters();

    // Daily checks (trial expiry, delinquency, card expiry)
    if (state.lastDailyRun !== todayStr) {
      await runBillingChecks(now);
      state.lastDailyRun = todayStr;
    }
  } catch (err: any) {
    Logger.error(`[Billing] Scheduler tick failed: ${JSON.stringify(err)}`);
  }
}

export async function runBillingChecks(now: Date): Promise<void> {
  Logger.info("[Billing] Running daily billing checks");

  const { db } = await import("~/server/db");

  // 1. Check trial expiry
  await checkTrialExpiry(db);

  // 2. Check delinquency
  await checkDelinquency(db);

  // 3. Check card expiry notifications
  await checkCardExpiry(db);

  // 4. Send trial ending reminders
  await sendTrialReminders(db);

  // 5. Clean up R2 buckets for deleted repos
  await cleanupDeletedRepoStorage(db);
}

async function checkCardExpiry(db: PrismaClient): Promise<void> {
  if (!isStripeEnabled()) return;

  const notifyDays = getCardExpiryNotifyDays();
  const stripe = getStripeClient();

  const orgs = await db.org.findMany({
    where: {
      subscriptionStatus: { in: ["ACTIVE", "TRIAL"] },
      stripeCustomerId: { not: null },
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      stripeCustomerId: true,
    },
  });

  for (const org of orgs) {
    if (!org.stripeCustomerId) continue;

    try {
      const methods = await stripe.paymentMethods.list({
        customer: org.stripeCustomerId,
        type: "card",
      });
      const now = TimeManager.date();

      for (const method of methods.data) {
        if (method.type !== "card" || !method.card) continue;

        const { exp_month: expiryMonth, exp_year: expiryYear } = method.card;
        if (!expiryMonth || !expiryYear) continue;

        const expiryDate = new Date(expiryYear, expiryMonth - 1, 28);
        const daysUntilExpiry = Math.floor(
          (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        );

        for (const threshold of notifyDays) {
          if (daysUntilExpiry <= threshold && daysUntilExpiry > 0) {
            const existing = await db.cardExpiryNotification.findUnique({
              where: {
                orgId_paymentMethodId_notifyDaysBefore: {
                  orgId: org.id,
                  paymentMethodId: method.id,
                  notifyDaysBefore: threshold,
                },
              },
            });

            if (!existing) {
              const last4 = method.card.last4 ?? "****";
              const expiryStr = `${String(expiryMonth).padStart(2, "0")}/${expiryYear}`;

              const admins = await db.orgUser.findMany({
                where: { orgId: org.id, role: { in: ["ADMIN", "BILLING"] } },
                include: { user: { select: { email: true } } },
              });

              for (const admin of admins) {
                await sendEmail({
                  to: admin.user.email,
                  ...cardExpiryEmail(
                    org.name,
                    last4,
                    expiryStr,
                    `/${org.name}/settings/billing`,
                  ),
                });
              }

              await db.cardExpiryNotification.create({
                data: {
                  orgId: org.id,
                  paymentMethodId: method.id,
                  expiryMonth,
                  expiryYear,
                  notifyDaysBefore: threshold,
                },
              });
            }
          }
        }
      }
    } catch (err: any) {
      Logger.warn(
        `[Billing] Failed to check card expiry for org ${org.name}: ${JSON.stringify(err)}`,
      );
    }
  }
}

async function sendTrialReminders(db: PrismaClient): Promise<void> {
  const now = TimeManager.date();
  const reminderThreshold = new Date(now);
  reminderThreshold.setDate(reminderThreshold.getDate() + 7);

  const trialOrgs = await db.org.findMany({
    where: {
      subscriptionStatus: "TRIAL",
      canceledAt: null,
      trialEndsAt: {
        gte: now,
        lte: reminderThreshold,
      },
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      trialEndsAt: true,
    },
  });

  for (const org of trialOrgs) {
    if (!org.trialEndsAt) continue;

    const daysRemaining = Math.ceil(
      (org.trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    // 5-day charge warning (explicit "you will be charged" notice)
    if (daysRemaining === 5) {
      const admins = await db.orgUser.findMany({
        where: { orgId: org.id, role: { in: ["ADMIN", "BILLING"] } },
        include: { user: { select: { email: true } } },
      });

      for (const admin of admins) {
        await sendEmail({
          to: admin.user.email,
          ...trialChargeWarningEmail(org.name, daysRemaining),
        });
      }
    }

    // General trial ending reminders at 7, 3, and 1 days
    if (daysRemaining === 7 || daysRemaining === 3 || daysRemaining === 1) {
      const admins = await db.orgUser.findMany({
        where: { orgId: org.id, role: { in: ["ADMIN", "BILLING"] } },
        include: { user: { select: { email: true } } },
      });

      for (const admin of admins) {
        await sendEmail({
          to: admin.user.email,
          ...trialEndingEmail(org.name, daysRemaining),
        });
      }
    }
  }
}

/**
 * Report all meter events (users + storage) to Stripe for active orgs.
 * Runs every scheduler tick (~hourly). Processes orgs in staggered batches
 * to stay under Stripe API rate limits and avoid internal load spikes.
 */
async function reportMeters(): Promise<void> {
  if (!isStripeEnabled()) return;

  const { db } = await import("~/server/db");

  const orgs = await db.org.findMany({
    where: {
      subscriptionStatus: { in: ["TRIAL", "ACTIVE", "PAST_DUE"] },
      stripeCustomerId: { not: null },
      deletedAt: null,
    },
    select: { id: true, name: true, selfHosted: true, stripeCustomerId: true },
  });

  if (orgs.length === 0) return;

  Logger.info(
    `[Billing] Reporting meters for ${orgs.length} orgs (batch size: ${METER_BATCH_SIZE})`,
  );

  let success = 0;
  let failed = 0;

  for (let i = 0; i < orgs.length; i += METER_BATCH_SIZE) {
    const batch = orgs.slice(i, i + METER_BATCH_SIZE);

    await Promise.all(
      batch.map(async (org) => {
        if (!org.stripeCustomerId) return;

        try {
          // Self-hosted orgs don't have storage
          const storage = org.selfHosted
            ? { buckets: 0 }
            : await calculateStorageCharge(org.id, db);
          await reportOrgMeters(
            org.id,
            org.stripeCustomerId,
            storage.buckets,
            db,
          );
          success++;
        } catch (err: unknown) {
          failed++;
          Logger.warn(
            `[Billing] Failed to report meters for org ${org.name}: ${String(err)}`,
          );
        }
      }),
    );

    // Delay between batches to avoid rate limits
    if (i + METER_BATCH_SIZE < orgs.length) {
      await new Promise((resolve) => setTimeout(resolve, METER_BATCH_DELAY_MS));
    }
  }

  Logger.info(
    `[Billing] Meter reporting complete: ${success} reported, ${failed} failed`,
  );
}

/**
 * Clean up R2 buckets for repos that were soft-deleted more than 5 minutes ago.
 * Short delay avoids any Cloudflare API race conditions while minimizing
 * platform storage costs from orphaned buckets.
 */
export async function cleanupDeletedRepoStorage(
  db: PrismaClient,
): Promise<void> {
  if (!isR2Enabled()) return;

  const cutoff = new Date(TimeManager.now() - 5 * 60 * 1000); // 5 minutes ago

  const repos = await db.repo.findMany({
    where: {
      deletedAt: { not: null, lt: cutoff },
      r2BucketName: { not: null },
    },
    select: { id: true, r2BucketName: true, orgId: true },
  });

  if (repos.length === 0) return;

  Logger.info(
    `[Billing] Cleaning up R2 buckets for ${repos.length} deleted repos`,
  );

  let success = 0;
  let failed = 0;

  for (const repo of repos) {
    if (!repo.r2BucketName) continue;

    try {
      await deleteR2Bucket(repo.r2BucketName);
      await db.repo.update({
        where: { id: repo.id },
        data: { r2BucketName: null },
      });
      success++;
      Logger.debug(
        `[Billing] Deleted R2 bucket ${repo.r2BucketName} for repo ${repo.id}`,
      );
    } catch (err: unknown) {
      failed++;
      Logger.warn(
        `[Billing] Failed to delete R2 bucket ${repo.r2BucketName}: ${String(err)}`,
      );
    }
  }

  Logger.info(
    `[Billing] R2 cleanup complete: ${success} deleted, ${failed} failed`,
  );
}
