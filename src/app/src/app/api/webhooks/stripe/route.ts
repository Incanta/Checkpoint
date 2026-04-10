import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { Logger } from "~/server/logging";
import { isLicenseManager } from "~/server/license-utils";
import {
  isStripeEnabled,
  getStripeClient,
  getStripeWebhookSecret,
  getStripePriceConfig,
} from "~/server/stripe/client";
import { db } from "~/server/db";
import { markDelinquent } from "~/server/billing/delinquency";
import { startTrial } from "~/server/billing/trial";
import { sendEmail } from "~/server/email/service";
import { paymentFailedEmail } from "~/server/email/billing-templates";
import { createOrgDirectory } from "~/server/storage-service";

export async function POST(request: NextRequest) {
  if (!isLicenseManager() || !isStripeEnabled()) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const stripe = getStripeClient();
  const webhookSecret = getStripeWebhookSecret();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    Logger.warn(
      `[Stripe Webhook] Signature verification failed: ${JSON.stringify(err)}`,
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  Logger.debug(`[Stripe Webhook] Received: ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;

      case "invoice.paid":
        await handleInvoicePaid(event.data.object);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;

      default:
        Logger.debug(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err: any) {
    Logger.error(
      `[Stripe Webhook] Error handling ${event.type}: ${JSON.stringify(err)}`,
    );
  }

  return NextResponse.json({ received: true });
}

/**
 * Apply a scheduled tier downgrade if one is pending for the org
 * associated with this Stripe customer. Called when a new billing
 * period starts (invoice.paid).
 */
async function applyScheduledTierChange(
  stripeCustomerId: string,
): Promise<void> {
  const org = await db.org.findFirst({
    where: { stripeCustomerId, scheduledTier: { not: null } },
    select: {
      id: true,
      scheduledTier: true,
      stripeSubscriptionId: true,
    },
  });
  if (!org || !org.scheduledTier) return;

  const newTier = org.scheduledTier;

  // Update Stripe subscription items to new tier's prices
  if (org.stripeSubscriptionId) {
    try {
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(
        org.stripeSubscriptionId,
      );
      const prices = getStripePriceConfig();
      const tierKey = newTier.toLowerCase() as "basic" | "pro" | "studio";
      const cloudPrices = prices.cloud;
      const writeKey = `${tierKey}-write` as keyof typeof cloudPrices;
      const readKey = `${tierKey}-read` as keyof typeof cloudPrices;

      const items: Array<{
        id?: string;
        price?: string;
        deleted?: boolean;
      }> = [];
      for (const item of sub.items.data) {
        items.push({ id: item.id, deleted: true });
      }
      if (cloudPrices[writeKey]) items.push({ price: cloudPrices[writeKey] });
      if (cloudPrices[readKey]) items.push({ price: cloudPrices[readKey] });
      if (cloudPrices.storage) items.push({ price: cloudPrices.storage });
      if (cloudPrices["minimum-due"])
        items.push({ price: cloudPrices["minimum-due"] });

      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        items,
        metadata: { tier: newTier },
      });
    } catch (err: any) {
      Logger.warn(
        `[Stripe Webhook] Failed to apply scheduled tier change to Stripe: ${JSON.stringify(err)}`,
      );
    }
  }

  // Apply locally
  await db.org.update({
    where: { id: org.id },
    data: {
      subscriptionTier: newTier,
      scheduledTier: null,
      scheduledTierAt: null,
    },
  });

  await db.license.updateMany({
    where: { orgId: org.id },
    data: { tier: newTier },
  });

  Logger.info(
    `[Stripe Webhook] Applied scheduled tier change to ${newTier} for org ${org.id}`,
  );
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const orgName = session.metadata?.orgName;
  const userId = session.metadata?.userId;
  if (!orgName || !userId) {
    Logger.warn(
      "[Stripe Webhook] checkout.session.completed missing orgName or userId metadata",
    );
    return;
  }

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;

  const tier = (session.metadata?.tier ?? "BASIC") as
    | "BASIC"
    | "PRO"
    | "STUDIO";
  const useTrial = session.metadata?.useTrial === "true";

  // Create the org now that checkout succeeded
  const org = await db.org.create({
    data: {
      name: orgName,
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscriptionId ?? undefined,
      subscriptionStatus: useTrial ? "TRIAL" : "ACTIVE",
      subscriptionTier: tier,
    },
  });

  // Add the user as admin
  await db.orgUser.create({
    data: {
      orgId: org.id,
      userId,
      role: "ADMIN",
    },
  });

  // Create org directory in storage
  try {
    await createOrgDirectory(org.id);
  } catch (error: any) {
    Logger.error(
      `[Stripe Webhook] Failed to create org directory for ${org.id}: ${JSON.stringify(error)}`,
    );
  }

  // Start trial if requested
  if (useTrial) {
    try {
      await startTrial(org.id, userId, db);
    } catch (err: any) {
      Logger.warn(
        `[Stripe Webhook] Failed to start trial for org ${org.id}: ${JSON.stringify(err)}`,
      );
    }
  }

  Logger.info(
    `[Stripe Webhook] Checkout completed — created org "${orgName}" (${org.id}), subscription ${subscriptionId ?? "none"}, tier ${tier}`,
  );
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const stripeInvoiceId = invoice.id;
  if (!stripeInvoiceId) return;

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;

  // Apply any scheduled tier change on new billing period
  if (customerId) {
    await applyScheduledTierChange(customerId);
  }

  // Try to find our local invoice by Stripe invoice ID
  const localInvoice = await db.invoice.findUnique({
    where: { stripeInvoiceId },
  });

  if (localInvoice) {
    await db.invoice.update({
      where: { id: localInvoice.id },
      data: { status: "PAID", paidAt: new Date() },
    });

    // Clear delinquency if all invoices are now paid
    const org = await db.org.findUnique({
      where: { id: localInvoice.orgId },
      select: { subscriptionStatus: true },
    });

    if (org?.subscriptionStatus === "PAST_DUE") {
      const unpaid = await db.invoice.count({
        where: {
          orgId: localInvoice.orgId,
          status: { in: ["ISSUED", "FAILED"] },
        },
      });

      if (unpaid === 0) {
        await db.org.update({
          where: { id: localInvoice.orgId },
          data: {
            subscriptionStatus: "ACTIVE",
            delinquentSince: null,
          },
        });
        Logger.info(
          `[Stripe Webhook] All invoices paid for org ${localInvoice.orgId} — restored to ACTIVE`,
        );
      }
    }

    Logger.info(
      `[Stripe Webhook] Invoice ${stripeInvoiceId} paid — local invoice ${localInvoice.id} marked PAID`,
    );
  } else {
    // Stripe-generated invoice we don't track locally (e.g., first subscription invoice)
    // Try to find org by customer ID and create a local record
    const customerId =
      typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer?.id;
    if (customerId && invoice.total > 0) {
      const org = await db.org.findFirst({
        where: { stripeCustomerId: customerId },
      });
      if (org) {
        const now = new Date();
        await db.invoice.create({
          data: {
            orgId: org.id,
            stripeInvoiceId,
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            status: "PAID",
            subtotalCents: invoice.subtotal,
            creditAppliedCents: 0,
            minimumDueAddedCents: 0,
            totalCents: invoice.total,
            paidAt: now,
          },
        });
      }
    }
  }
}

async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<void> {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return;

  const org = await db.org.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true, name: true },
  });

  if (!org) return;

  // Update local invoice if we have one
  const stripeInvoiceId = invoice.id;
  if (stripeInvoiceId) {
    const localInvoice = await db.invoice.findUnique({
      where: { stripeInvoiceId },
    });
    if (localInvoice) {
      await db.invoice.update({
        where: { id: localInvoice.id },
        data: { status: "FAILED", failedAt: new Date() },
      });
    }
  }

  // Mark org as delinquent
  await markDelinquent(org.id, db);

  // Notify admins
  const admins = await db.orgUser.findMany({
    where: {
      orgId: org.id,
      role: { in: ["ADMIN", "BILLING"] },
    },
    include: { user: { select: { email: true } } },
  });

  for (const admin of admins) {
    try {
      await sendEmail({
        to: admin.user.email,
        ...paymentFailedEmail(
          org.name,
          invoice.amount_due,
          `/${org.name}/settings/billing`,
        ),
      });
    } catch {
      // Non-critical
    }
  }

  Logger.warn(
    `[Stripe Webhook] Payment failed for invoice ${invoice.id} — org ${org.id}`,
  );
}

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
): Promise<void> {
  const org = await db.org.findFirst({
    where: { stripeSubscriptionId: subscription.id },
    select: { id: true },
  });
  if (!org) return;

  // Sync trial end date from Stripe
  if (subscription.trial_end) {
    await db.org.update({
      where: { id: org.id },
      data: {
        trialEndsAt: new Date(subscription.trial_end * 1000),
      },
    });
  }

  Logger.debug(
    `[Stripe Webhook] Subscription ${subscription.id} updated for org ${org.id}`,
  );
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const org = await db.org.findFirst({
    where: { stripeSubscriptionId: subscription.id },
    select: { id: true },
  });
  if (!org) return;

  await db.org.update({
    where: { id: org.id },
    data: {
      subscriptionStatus: "CANCELED",
      canceledAt: new Date(),
      stripeSubscriptionId: null,
    },
  });

  Logger.info(
    `[Stripe Webhook] Subscription ${subscription.id} deleted — org ${org.id} set to CANCELED`,
  );
}
