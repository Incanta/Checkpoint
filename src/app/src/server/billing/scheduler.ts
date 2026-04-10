import "server-only";

import { Logger } from "../logging";
import {
  isStripeEnabled,
  getCardExpiryNotifyDays,
  getStripeClient,
} from "../stripe/client";
import { generateMonthlyInvoice } from "./invoice";
import { checkTrialExpiry } from "./trial";
import { checkDelinquency } from "./delinquency";
import { calculateStorageCharge } from "./storage-usage";
import { reportOrgStorageMeters } from "./meter-reporting";
import { sendEmail } from "../email/service";
import {
  cardExpiryEmail,
  trialEndingEmail,
  trialChargeWarningEmail,
} from "../email/billing-templates";

// Track the last run dates to prevent duplicate runs
const SCHEDULER_STATE_KEY = Symbol.for("checkpoint.billing.scheduler");

interface SchedulerState {
  lastInvoiceRun: string | null; // "YYYY-MM" of last invoice generation
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
      lastInvoiceRun: null,
      lastDailyRun: null,
      intervalId: null,
    };
  }
  return globalForScheduler[SCHEDULER_STATE_KEY];
}

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Initialize the billing scheduler.
 * Checks every hour:
 * - On the 1st of the month: generate invoices / report meter events
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
  const now = new Date();
  const state = getSchedulerState();
  const todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const monthStr = todayStr.slice(0, 7); // "YYYY-MM"

  try {
    // Monthly invoice generation (1st of month)
    if (now.getDate() === 1 && state.lastInvoiceRun !== monthStr) {
      await runMonthlyInvoicing(now);
      state.lastInvoiceRun = monthStr;
    }

    // Daily checks (trial expiry, delinquency, card expiry)
    if (state.lastDailyRun !== todayStr) {
      await runDailyChecks(now);
      state.lastDailyRun = todayStr;
    }
  } catch (err: any) {
    Logger.error(`[Billing] Scheduler tick failed: ${JSON.stringify(err)}`);
  }
}

export async function runMonthlyInvoicing(now: Date): Promise<void> {
  Logger.info(
    "[Billing] Running monthly invoice generation / meter event reporting",
  );

  const { db } = await import("~/server/db");

  // Bill for the previous month
  const prevMonth = new Date(now);
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  const year = prevMonth.getFullYear();
  const month = prevMonth.getMonth() + 1;

  const orgs = await db.org.findMany({
    where: {
      subscriptionStatus: { in: ["ACTIVE", "TRIAL", "PAST_DUE"] },
      deletedAt: null,
      stripeCustomerId: { not: null },
    },
    select: { id: true, name: true },
  });

  Logger.info(
    `[Billing] Generating invoices for ${orgs.length} orgs (${year}-${month})`,
  );

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const org of orgs) {
    try {
      const result = await generateMonthlyInvoice(org.id, year, month, db);
      if (result.skipped) {
        skipped++;
      } else {
        success++;
      }
    } catch (err: any) {
      failed++;
      Logger.error(
        `[Billing] Failed to generate invoice for org ${org.name}: ${JSON.stringify(err)}`,
      );
    }
  }

  Logger.info(
    `[Billing] Invoice generation complete: ${success} created, ${skipped} skipped, ${failed} failed`,
  );
}

export async function runDailyChecks(now: Date): Promise<void> {
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

  // 5. Report storage meters to Stripe (daily catch-up)
  await reportDailyStorageMeters(db);
}

async function checkCardExpiry(
  db: import("@prisma/client").PrismaClient,
): Promise<void> {
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
      const now = new Date();

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

async function sendTrialReminders(
  db: import("@prisma/client").PrismaClient,
): Promise<void> {
  const now = new Date();

  // Find trial orgs ending in ~7 days
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
 * Report storage meter events to Stripe for all active orgs.
 * Runs daily as a catch-up — storage changes slowly and is too expensive for real-time.
 */
async function reportDailyStorageMeters(
  db: import("@prisma/client").PrismaClient,
): Promise<void> {
  if (!isStripeEnabled()) return;

  const orgs = await db.org.findMany({
    where: {
      subscriptionStatus: { in: ["ACTIVE", "PAST_DUE"] },
      stripeCustomerId: { not: null },
      deletedAt: null,
    },
    select: { id: true, name: true, stripeCustomerId: true },
  });

  Logger.info(
    `[Billing] Reporting daily storage meters for ${orgs.length} orgs`,
  );

  let success = 0;
  let failed = 0;

  for (const org of orgs) {
    if (!org.stripeCustomerId) continue;

    try {
      const storage = await calculateStorageCharge(org.id, db);
      await reportOrgStorageMeters(
        org.id,
        org.stripeCustomerId,
        storage.buckets,
        db,
      );
      success++;
    } catch (err: unknown) {
      failed++;
      Logger.warn(
        `[Billing] Failed to report storage meters for org ${org.name}: ${String(err)}`,
      );
    }
  }

  Logger.info(
    `[Billing] Daily storage meters complete: ${success} reported, ${failed} failed`,
  );
}