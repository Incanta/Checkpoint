import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import { getStripeClient, isStripeEnabled } from "../stripe/client";

/**
 * Apply org credits as a discount on the invoice subtotal.
 * With Stripe, credits are tracked via Customer Balance which auto-applies to invoices.
 * This function is kept for local tracking and pre-calculation of minimum due.
 */
export async function applyCredits(
  orgId: string,
  subtotalCents: number,
  db: PrismaClient,
): Promise<{ discountCents: number; remainingCreditsCents: number }> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { creditBalanceCents: true },
  });

  if (org.creditBalanceCents <= 0 || subtotalCents <= 0) {
    return {
      discountCents: 0,
      remainingCreditsCents: org.creditBalanceCents,
    };
  }

  const discountCents = Math.min(org.creditBalanceCents, subtotalCents);
  const remainingCreditsCents = org.creditBalanceCents - discountCents;

  await db.org.update({
    where: { id: orgId },
    data: { creditBalanceCents: remainingCreditsCents },
  });

  Logger.debug(
    `[Billing] Applied ${discountCents}c credits for org ${orgId}, remaining: ${remainingCreditsCents}c`,
  );

  return { discountCents, remainingCreditsCents };
}

/**
 * Add credits to an org's balance (e.g., minimum-due overage).
 * Also syncs to Stripe Customer Balance for automatic invoice application.
 */
export async function addCredits(
  orgId: string,
  amountCents: number,
  db: PrismaClient,
): Promise<void> {
  if (amountCents <= 0) return;

  await db.org.update({
    where: { id: orgId },
    data: { creditBalanceCents: { increment: amountCents } },
  });

  // Sync to Stripe Customer Balance (negative amount = credit)
  if (isStripeEnabled()) {
    try {
      const org = await db.org.findUniqueOrThrow({
        where: { id: orgId },
        select: { stripeCustomerId: true },
      });
      if (org.stripeCustomerId) {
        const stripe = getStripeClient();
        await stripe.customers.createBalanceTransaction(org.stripeCustomerId, {
          amount: -amountCents,
          currency: "usd",
        });
      }
    } catch (err: any) {
      Logger.warn(
        `[Billing] Failed to sync credits to Stripe for org ${orgId}: ${JSON.stringify(err)}`,
      );
    }
  }

  Logger.debug(`[Billing] Added ${amountCents}c credits for org ${orgId}`);
}

/**
 * Get the current credit balance for an org.
 */
export async function getCreditBalance(
  orgId: string,
  db: PrismaClient,
): Promise<number> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { creditBalanceCents: true },
  });
  return org.creditBalanceCents;
}
