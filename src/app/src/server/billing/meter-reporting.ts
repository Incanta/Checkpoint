import "server-only";

import type { PrismaClient } from "@prisma/client";
import config from "@incanta/config";
import { Logger } from "../logging";
import { TimeManager } from "../time";
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
 * for a given org, derived from OrgUserActivity.
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
      TimeManager.date(),
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
  storageUsageGb: number,
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

    interface TierPrices {
      write: number;
      read: number;
    }

    interface ServicePrices {
      basic: TierPrices;
      pro: TierPrices;
      studio: TierPrices;
    }

    interface SeatPrices {
      cloud: ServicePrices;
    }

    const seatPrices = config.get<SeatPrices>("stripe.seat-prices");
    const tier = org.subscriptionTier.toLowerCase() as keyof ServicePrices;
    const prices = seatPrices.cloud[tier];
    const { bucketPriceCents } = getStoragePricingConfig();
    const stripe = getStripeClient();
    const minInvoice = getMinimumInvoiceCents();

    const userCharges = writeUsers * prices.write + readUsers * prices.read;
    const storageCharges = storageBuckets * bucketPriceCents;

    // Fetch available credit from Stripe customer balance
    let creditCents = 0;
    if (minInvoice !== null) {
      try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        if (!customer.deleted) {
          // Stripe balance: negative = credit available
          creditCents = Math.max(0, -(customer.balance ?? 0));
        }
      } catch {
        // Non-critical — proceed without credit offset
      }
    }

    const subtotal = Math.max(0, userCharges + storageCharges - creditCents);

    let minimumDueCents = 0;
    if (minInvoice !== null && subtotal > 0 && subtotal < minInvoice) {
      minimumDueCents = minInvoice - subtotal;
    }

    if (org.canceledAt) {
      // don't charge for a minimum if the subscription is canceled to prevent refunds
      minimumDueCents = 0;
    }

    const meters = getMeterNames();
    const timestamp = Math.floor(TimeManager.now() / 1000);

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
      // if the user canceled during a trial, they get 25 free GB
      const effectiveBuckets =
        org.subscriptionStatus === "TRIAL" && org.canceledAt
          ? Math.ceil(
              Math.max(0, storageUsageGb - 25) /
                getStoragePricingConfig().bucketSizeGb,
            )
          : storageBuckets;

      await stripe.billing.meterEvents.create({
        event_name: meters.storageBuckets,
        timestamp,
        payload: {
          value: String(effectiveBuckets),
          stripe_customer_id: stripeCustomerId,
        },
      });
    }

    if (minInvoice !== null) {
      await stripe.billing.meterEvents.create({
        event_name: meters.minimumDue,
        timestamp,
        payload: {
          value: String(minimumDueCents),
          stripe_customer_id: stripeCustomerId,
        },
      });
    }

    Logger.debug(
      `[Billing] Reported meters for org ${orgId}: write=${writeUsers}, read=${readUsers}, storage=${storageBuckets} buckets`,
    );
  } catch (err: unknown) {
    Logger.warn(
      `[Billing] Failed to report meters for org ${orgId}: ${String(err)}`,
    );
  }
}
