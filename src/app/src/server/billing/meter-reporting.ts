import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import {
  getStripeClient,
  isStripeEnabled,
  getMeterNames,
  getMinimumInvoiceCents,
  getStoragePricingConfig,
} from "../stripe/client";

// In-memory debounce map: orgId → last report timestamp (ms)
const DEBOUNCE_KEY = Symbol.for("checkpoint.billing.meterDebounce");
const DEBOUNCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const globalForDebounce = globalThis as unknown as {
  [DEBOUNCE_KEY]?: Map<string, number>;
};

function getDebounceMap(): Map<string, number> {
  if (!globalForDebounce[DEBOUNCE_KEY]) {
    globalForDebounce[DEBOUNCE_KEY] = new Map();
  }
  return globalForDebounce[DEBOUNCE_KEY];
}

/**
 * Report the current user meter values (write/read/minimum-due) to Stripe
 * for a given org. Debounced per-org to avoid excessive API calls.
 *
 * Fire-and-forget — callers should not await or depend on the result.
 */
export async function reportOrgUserMeters(
  orgId: string,
  db: PrismaClient,
): Promise<void> {
  if (!isStripeEnabled()) return;

  // Debounce check
  const debounceMap = getDebounceMap();
  const lastReport = debounceMap.get(orgId) ?? 0;
  if (Date.now() - lastReport < DEBOUNCE_INTERVAL_MS) return;

  try {
    const org = await db.org.findUnique({
      where: { id: orgId },
      select: {
        stripeCustomerId: true,
        subscriptionStatus: true,
        subscriptionTier: true,
      },
    });

    if (!org?.stripeCustomerId) return;
    // Don't report meters during trial — Stripe skips invoicing during trial
    if (org.subscriptionStatus === "TRIAL") return;
    // Only report for active subscriptions
    if (!["ACTIVE", "PAST_DUE"].includes(org.subscriptionStatus ?? "")) return;

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    const activities = await db.orgUserActivity.findMany({
      where: { orgId, year, month },
      select: { writeCount: true, readCount: true },
    });

    const writeUsers = activities.filter((u) => u.writeCount > 0).length;
    const readUsers = activities.filter(
      (u) => u.readCount > 0 && u.writeCount === 0,
    ).length;

    await reportUserMeterEvents(
      org.stripeCustomerId,
      writeUsers,
      readUsers,
    );

    // Update debounce timestamp
    debounceMap.set(orgId, Date.now());

    Logger.debug(
      `[Billing] Reported user meters for org ${orgId}: ${writeUsers}w/${readUsers}r`,
    );
  } catch (err: unknown) {
    Logger.warn(
      `[Billing] Failed to report user meters for org ${orgId}: ${String(err)}`,
    );
  }
}

/**
 * Report storage and minimum-due meters for an org.
 * Called by the daily scheduler — not real-time (too expensive).
 */
export async function reportOrgStorageMeters(
  orgId: string,
  stripeCustomerId: string,
  storageBuckets: number,
  db: PrismaClient,
): Promise<void> {
  if (!isStripeEnabled()) return;

  try {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    // Get current user counts for minimum-due calculation
    const activities = await db.orgUserActivity.findMany({
      where: { orgId, year, month },
      select: { writeCount: true, readCount: true },
    });

    const writeUsers = activities.filter((u) => u.writeCount > 0).length;
    const readUsers = activities.filter(
      (u) => u.readCount > 0 && u.writeCount === 0,
    ).length;

    const org = await db.org.findUnique({
      where: { id: orgId },
      select: { subscriptionTier: true },
    });

    // Calculate approximate minimum due based on current meters
    const SEAT_PRICES: Record<string, { write: number; read: number }> = {
      BASIC: { write: 300, read: 150 },
      PRO: { write: 600, read: 300 },
      STUDIO: { write: 1400, read: 700 },
    };
    const tier = (org?.subscriptionTier ?? "BASIC") as string;
    const prices = SEAT_PRICES[tier] ?? SEAT_PRICES.BASIC!;
    const { bucketPriceCents } = getStoragePricingConfig();

    const userCharges =
      writeUsers * prices.write + readUsers * prices.read;
    const storageCharges = storageBuckets * bucketPriceCents;
    const subtotal = userCharges + storageCharges;

    let minimumDueCents = 0;
    const minInvoice = getMinimumInvoiceCents();
    if (subtotal > 0 && subtotal < minInvoice) {
      minimumDueCents = minInvoice - subtotal;
    }

    await reportStorageMeterEvents(
      stripeCustomerId,
      storageBuckets,
      minimumDueCents,
    );

    Logger.debug(
      `[Billing] Reported storage meters for org ${orgId}: ${storageBuckets} buckets, min-due ${minimumDueCents}c`,
    );
  } catch (err: unknown) {
    Logger.warn(
      `[Billing] Failed to report storage meters for org ${orgId}: ${String(err)}`,
    );
  }
}

/** Report write/read user meter events to Stripe. */
async function reportUserMeterEvents(
  stripeCustomerId: string,
  writeUsers: number,
  readUsers: number,
): Promise<void> {
  const stripe = getStripeClient();
  const meters = getMeterNames();
  const timestamp = Math.floor(Date.now() / 1000);

  if (writeUsers > 0) {
    await stripe.billing.meterEvents.create({
      event_name: meters.writeUsers,
      timestamp,
      payload: {
        value: String(writeUsers),
        stripe_customer_id: stripeCustomerId,
      },
    });
  }
  if (readUsers > 0) {
    await stripe.billing.meterEvents.create({
      event_name: meters.readUsers,
      timestamp,
      payload: {
        value: String(readUsers),
        stripe_customer_id: stripeCustomerId,
      },
    });
  }
}

/** Report storage and minimum-due meter events to Stripe. */
async function reportStorageMeterEvents(
  stripeCustomerId: string,
  storageBuckets: number,
  minimumDueCents: number,
): Promise<void> {
  const stripe = getStripeClient();
  const meters = getMeterNames();
  const timestamp = Math.floor(Date.now() / 1000);

  if (storageBuckets > 0) {
    await stripe.billing.meterEvents.create({
      event_name: meters.storageBuckets,
      timestamp,
      payload: {
        value: String(storageBuckets),
        stripe_customer_id: stripeCustomerId,
      },
    });
  }
  if (minimumDueCents > 0) {
    await stripe.billing.meterEvents.create({
      event_name: meters.minimumDue,
      timestamp,
      payload: {
        value: String(minimumDueCents),
        stripe_customer_id: stripeCustomerId,
      },
    });
  }
}
