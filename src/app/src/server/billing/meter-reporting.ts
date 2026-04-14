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
import { getBillingPeriod } from "./billing-period";

/**
 * Report the current user meter values (write/read) to Stripe
 * for a given org.
 */
export async function getOrgUserMeters(
  org: {
    id: string;
    billingCycleAnchor: number;
    canceledAt: Date | null;
    stripeCustomerId: string | null;
    subscriptionStatus: string | null;
    subscriptionTier: string | null;
  },
  db: PrismaClient,
): Promise<{ writeUsers: number; readUsers: number } | null> {
  if (!isStripeEnabled()) return null;

  try {
    if (!org.stripeCustomerId) return null;
    // Only report for active subscriptions
    if (!["TRIAL", "ACTIVE", "PAST_DUE"].includes(org.subscriptionStatus ?? ""))
      return null;

    const { year, month } = getBillingPeriod(
      new Date(),
      org.billingCycleAnchor,
    );

    const activities = await db.orgUserActivity.findMany({
      where: { orgId: org.id, year, month },
      select: { writeCount: true, readCount: true },
    });

    const writeUsers = activities.filter((u) => u.writeCount > 0).length;
    const readUsers = activities.filter(
      (u) => u.readCount > 0 && u.writeCount === 0,
    ).length;

    if (org.subscriptionStatus === "TRIAL" && org.canceledAt) {
      return { writeUsers: 0, readUsers: 0 };
    } else {
      return { writeUsers, readUsers };
    }
  } catch (err: unknown) {
    Logger.warn(
      `[Billing] Failed to report user meters for org ${org.id}: ${String(err)}`,
    );

    return null;
  }
}

/**
 * Report storage and minimum-due meters for an org.
 */
export async function reportOrgMeters(
  orgId: string,
  stripeCustomerId: string,
  storageBuckets: number,
  db: PrismaClient,
): Promise<void> {
  if (!isStripeEnabled()) return;

  try {
    const org = await db.org.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        subscriptionTier: true,
        billingCycleAnchor: true,
        stripeCustomerId: true,
        subscriptionStatus: true,
        canceledAt: true,
      },
    });

    if (!org?.stripeCustomerId) {
      Logger.warn(
        `[Billing] Cannot report meters for org ${orgId} without Stripe customer ID`,
      );
      return;
    }

    const { writeUsers, readUsers } = (await getOrgUserMeters(org, db)) ?? {
      writeUsers: 0,
      readUsers: 0,
    };

    // Calculate approximate minimum due based on current meters
    const SEAT_PRICES: Record<string, { write: number; read: number }> = {
      BASIC: { write: 300, read: 150 },
      PRO: { write: 600, read: 300 },
      STUDIO: { write: 1400, read: 700 },
    };
    const tier = (org?.subscriptionTier ?? "BASIC") as string;
    const prices = SEAT_PRICES[tier] ?? SEAT_PRICES.BASIC!;
    const { bucketPriceCents } = getStoragePricingConfig();

    const userCharges = writeUsers * prices.write + readUsers * prices.read;
    const storageCharges = storageBuckets * bucketPriceCents;
    const subtotal = userCharges + storageCharges;

    let minimumDueCents = 0;
    const minInvoice = getMinimumInvoiceCents();
    if (subtotal > 0 && subtotal < minInvoice) {
      minimumDueCents = minInvoice - subtotal;
    }

    if (org.subscriptionStatus === "TRIAL" && org.canceledAt) {
      minimumDueCents = 0;
    }

    const stripe = getStripeClient();
    const meters = getMeterNames();
    const timestamp = Math.floor(Date.now() / 1000);

    await stripe.billing.meterEvents.create({
      event_name: meters.writeUsers,
      timestamp,
      payload: {
        value: String(writeUsers),
        stripe_customer_id: stripeCustomerId,
      },
    });

    await stripe.billing.meterEvents.create({
      event_name: meters.readUsers,
      timestamp,
      payload: {
        value: String(readUsers),
        stripe_customer_id: stripeCustomerId,
      },
    });

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

    await stripe.billing.meterEvents.create({
      event_name: meters.minimumDue,
      timestamp,
      payload: {
        value: String(minimumDueCents),
        stripe_customer_id: stripeCustomerId,
      },
    });

    Logger.debug(
      `[Billing] Reported storage meters for org ${orgId}: ${storageBuckets} buckets, min-due ${minimumDueCents}c`,
    );
  } catch (err: unknown) {
    Logger.warn(
      `[Billing] Failed to report storage meters for org ${orgId}: ${String(err)}`,
    );
  }
}
