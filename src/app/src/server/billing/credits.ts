import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import { getStripeClient, isStripeEnabled } from "../stripe/client";

/**
 * Add credits to an org via a Stripe Customer Balance Transaction.
 * Stripe Customer Balance is the source of truth — a negative balance means
 * the customer has credit that Stripe automatically applies to future invoices.
 * The local `creditBalanceCents` is a display cache updated via `syncCreditBalance()`.
 */
export async function addCredits(
  orgId: string,
  amountCents: number,
  description: string,
  db: PrismaClient,
): Promise<void> {
  if (amountCents <= 0) return;

  if (!isStripeEnabled()) {
    // Non-Stripe environments: local tracking only
    await db.org.update({
      where: { id: orgId },
      data: { creditBalanceCents: { increment: amountCents } },
    });
    Logger.debug(`[Billing] Added ${amountCents}c credits for org ${orgId} (local only)`);
    return;
  }

  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { stripeCustomerId: true },
  });

  if (!org.stripeCustomerId) {
    Logger.warn(
      `[Billing] Cannot add credits for org ${orgId}: no Stripe customer`,
    );
    return;
  }

  try {
    const stripe = getStripeClient();
    // Negative amount = credit on Stripe Customer Balance
    await stripe.customers.createBalanceTransaction(org.stripeCustomerId, {
      amount: -amountCents,
      currency: "usd",
      description,
    });

    // Sync the cache from Stripe
    await syncCreditBalance(orgId, org.stripeCustomerId, db);

    Logger.info(
      `[Billing] Added ${amountCents}c credits for org ${orgId}: ${description}`,
    );
  } catch (err: unknown) {
    Logger.warn(
      `[Billing] Failed to add credits to Stripe for org ${orgId}: ${String(err)}`,
    );
  }
}

/**
 * Fetch the Stripe Customer Balance and update the local cache.
 * Stripe stores credit as a negative balance; we store the absolute value.
 */
export async function syncCreditBalance(
  orgId: string,
  stripeCustomerId: string,
  db: PrismaClient,
): Promise<number> {
  if (!isStripeEnabled()) {
    const org = await db.org.findUniqueOrThrow({
      where: { id: orgId },
      select: { creditBalanceCents: true },
    });
    return org.creditBalanceCents;
  }

  try {
    const stripe = getStripeClient();
    const customer = await stripe.customers.retrieve(stripeCustomerId);

    if (customer.deleted) {
      return 0;
    }

    // Stripe balance: negative = credit available. Convert to positive for display.
    const creditCents = Math.max(0, -(customer.balance ?? 0));

    await db.org.update({
      where: { id: orgId },
      data: { creditBalanceCents: creditCents },
    });

    return creditCents;
  } catch (err: unknown) {
    Logger.warn(
      `[Billing] Failed to sync credit balance from Stripe for org ${orgId}: ${String(err)}`,
    );
    // Fall back to cached value
    const org = await db.org.findUniqueOrThrow({
      where: { id: orgId },
      select: { creditBalanceCents: true },
    });
    return org.creditBalanceCents;
  }
}

/**
 * Get the credit balance for an org, fetching from Stripe if available.
 */
export async function getCreditBalance(
  orgId: string,
  db: PrismaClient,
): Promise<number> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { creditBalanceCents: true, stripeCustomerId: true },
  });

  if (isStripeEnabled() && org.stripeCustomerId) {
    return syncCreditBalance(orgId, org.stripeCustomerId, db);
  }

  return org.creditBalanceCents;
}
