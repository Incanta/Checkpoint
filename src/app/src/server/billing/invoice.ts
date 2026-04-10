import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import {
  getStripeClient,
  isStripeEnabled,
  getMeterNames,
  getMinimumInvoiceCents,
  getSeatPriceId,
} from "../stripe/client";
import { calculateStorageCharge } from "./storage-usage";
import { applyCredits, addCredits } from "./credits";
import type { LicenseTier } from "../license-utils";

// Seat unit prices in cents for local invoice tracking
const SEAT_PRICES: Record<string, { write: number; read: number }> = {
  BASIC: { write: 300, read: 150 },
  PRO: { write: 600, read: 300 },
  STUDIO: { write: 1400, read: 700 },
};

export interface GenerateInvoiceResult {
  invoiceId: string;
  totalCents: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Report usage meter events to Stripe and create a local invoice record.
 * Stripe generates the actual invoice automatically at billing cycle end.
 */
export async function generateMonthlyInvoice(
  orgId: string,
  year: number,
  month: number,
  db: PrismaClient,
): Promise<GenerateInvoiceResult> {
  // Check for duplicate
  const existing = await db.invoice.findUnique({
    where: { orgId_year_month: { orgId, year, month } },
  });
  if (existing) {
    return {
      invoiceId: existing.id,
      totalCents: existing.totalCents,
      skipped: true,
      reason: "Invoice already exists",
    };
  }

  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: {
      id: true,
      subscriptionTier: true,
      subscriptionStatus: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      trialEndsAt: true,
    },
  });

  const isTrial = org.subscriptionStatus === "TRIAL";
  const tier = org.subscriptionTier as LicenseTier;
  const tierPrices = SEAT_PRICES[tier] ?? SEAT_PRICES.BASIC!;

  // Count distinct active users by type
  const activeUsers = await db.orgUserActivity.findMany({
    where: { orgId, year, month },
    select: { writeCount: true, readCount: true },
  });

  const awu = activeUsers.filter((u) => u.writeCount > 0).length;
  const aru = activeUsers.filter(
    (u) => u.readCount > 0 && u.writeCount === 0,
  ).length;

  // Build line items
  const items: Array<{
    type: "SEAT_READ" | "SEAT_WRITE" | "STORAGE" | "MINIMUM_DUE";
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    stripePriceId: string | null;
  }> = [];

  // Seat charges (skip during trial — Stripe skips invoicing during trial)
  if (!isTrial) {
    const writePriceId = getSeatPriceId(tier, "write");
    if (awu > 0) {
      items.push({
        type: "SEAT_WRITE",
        description: `${tier} Write Seats`,
        quantity: awu,
        unitPriceCents: tierPrices.write,
        totalCents: awu * tierPrices.write,
        stripePriceId: writePriceId,
      });
    }

    const readPriceId = getSeatPriceId(tier, "read");
    if (aru > 0) {
      items.push({
        type: "SEAT_READ",
        description: `${tier} Read Seats`,
        quantity: aru,
        unitPriceCents: tierPrices.read,
        totalCents: aru * tierPrices.read,
        stripePriceId: readPriceId,
      });
    }
  }

  // Storage charges
  const storage = await calculateStorageCharge(orgId, db);
  if (storage.chargeCents > 0) {
    items.push({
      type: "STORAGE",
      description: `Storage: ${storage.totalGB.toFixed(1)} GB (${storage.buckets} bucket${storage.buckets !== 1 ? "s" : ""})`,
      quantity: storage.buckets,
      unitPriceCents: Math.round(storage.chargeCents / storage.buckets),
      totalCents: storage.chargeCents,
      stripePriceId: null,
    });
  }

  // If no items at all, create a $0 invoice record
  if (items.length === 0) {
    Logger.debug(
      `[Billing] No billable items for org ${orgId} (${year}-${month}), creating $0 invoice`,
    );
    const invoice = await db.invoice.create({
      data: {
        orgId,
        year,
        month,
        status: "PAID",
        subtotalCents: 0,
        creditAppliedCents: 0,
        minimumDueAddedCents: 0,
        totalCents: 0,
        paidAt: new Date(),
      },
    });
    return { invoiceId: invoice.id, totalCents: 0, skipped: false };
  }

  // Calculate subtotal
  const subtotalCents = items.reduce((sum, i) => sum + i.totalCents, 0);

  // Apply credits
  const { discountCents } = await applyCredits(orgId, subtotalCents, db);

  // Check minimum due
  let minimumDueAddedCents = 0;
  const afterCredits = subtotalCents - discountCents;
  const minInvoice = getMinimumInvoiceCents();

  if (afterCredits > 0 && afterCredits < minInvoice) {
    minimumDueAddedCents = minInvoice - afterCredits;
    items.push({
      type: "MINIMUM_DUE",
      description: "Minimum Due Adjustment",
      quantity: 1,
      unitPriceCents: minimumDueAddedCents,
      totalCents: minimumDueAddedCents,
      stripePriceId: null,
    });
    // Credit the overage for next month
    await addCredits(orgId, minimumDueAddedCents, db);
  }

  const totalCents = subtotalCents - discountCents + minimumDueAddedCents;

  // Create local invoice record
  const invoice = await db.invoice.create({
    data: {
      orgId,
      year,
      month,
      status: "DRAFT",
      subtotalCents,
      creditAppliedCents: discountCents,
      minimumDueAddedCents,
      totalCents,
      items: {
        create: items.map((item) => ({
          type: item.type,
          description: item.description,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          totalCents: item.totalCents,
          stripePriceId: item.stripePriceId,
        })),
      },
    },
  });

  // Report meter events to Stripe (Stripe generates invoice at billing cycle end)
  if (isStripeEnabled() && org.stripeCustomerId && !isTrial) {
    try {
      await reportMeterEvents(
        org.stripeCustomerId,
        awu,
        aru,
        storage.buckets,
        minimumDueAddedCents,
      );
      await db.invoice.update({
        where: { id: invoice.id },
        data: { status: "ISSUED", issuedAt: new Date() },
      });
      Logger.info(
        `[Billing] Reported meter events for org ${orgId} (${year}-${month}): ${awu}w/${aru}r users, ${storage.buckets} buckets, total ${totalCents}c`,
      );
    } catch (err: any) {
      Logger.error(
        `[Billing] Failed to report meter events for org ${orgId}: ${JSON.stringify(err)}`,
      );
      await db.invoice.update({
        where: { id: invoice.id },
        data: { status: "FAILED", failedAt: new Date() },
      });
    }
  }

  return { invoiceId: invoice.id, totalCents, skipped: false };
}

/**
 * Report usage meter events to Stripe.
 * Uses `last_during_period` aggregation — only the last reported value matters.
 */
async function reportMeterEvents(
  stripeCustomerId: string,
  writeUsers: number,
  readUsers: number,
  storageBuckets: number,
  minimumDueCents: number,
): Promise<void> {
  const stripe = getStripeClient();
  const meters = getMeterNames();
  const timestamp = Math.floor(Date.now() / 1000);

  const events: Array<{ event_name: string; value: number }> = [];

  if (writeUsers > 0) {
    events.push({ event_name: meters.writeUsers, value: writeUsers });
  }
  if (readUsers > 0) {
    events.push({ event_name: meters.readUsers, value: readUsers });
  }
  if (storageBuckets > 0) {
    events.push({ event_name: meters.storageBuckets, value: storageBuckets });
  }
  // Minimum due: report units at $0.01 each to pad invoice to $5
  if (minimumDueCents > 0) {
    events.push({ event_name: meters.minimumDue, value: minimumDueCents });
  }

  for (const event of events) {
    await stripe.billing.meterEvents.create({
      event_name: event.event_name,
      timestamp,
      payload: {
        value: String(event.value),
        stripe_customer_id: stripeCustomerId,
      },
    });
  }
}
