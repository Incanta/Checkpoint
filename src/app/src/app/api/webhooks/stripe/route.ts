import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import config from "@incanta/config";
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
import { addCredits, syncCreditBalance } from "~/server/billing/credits";
import { sendEmail } from "~/server/email/service";
import {
  paymentFailedEmail,
  accountDeletionWarningEmail,
} from "~/server/email/billing-templates";
import { createOrgDirectory } from "~/server/storage-service";
import crypto from "crypto";

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

      case "invoice.finalized":
        await handleInvoiceFinalized(event.data.object);
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
      selfHosted: true,
      subscriptionTier: true,
      scheduledTier: true,
      stripeSubscriptionId: true,
    },
  });
  if (!org?.scheduledTier) return;

  const newTier = org.scheduledTier;

  // Update Stripe subscription items to new tier's prices
  if (org.stripeSubscriptionId) {
    try {
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
      const prices = getStripePriceConfig();
      const tierKey = newTier.toLowerCase() as "basic" | "pro" | "studio";
      const priorTierKey = org.subscriptionTier.toLowerCase() as
        | "basic"
        | "pro"
        | "studio";

      const items: Array<{
        id?: string;
        price?: string;
        deleted?: boolean;
      }> = [];

      if (org.selfHosted) {
        const shPrices = prices.selfHosted;
        const writeKey = `${tierKey}-write` as keyof typeof shPrices;
        const readKey = `${tierKey}-read` as keyof typeof shPrices;
        for (const item of sub.items.data) {
          if (
            item.price.id ===
            shPrices[`${priorTierKey}-write` as keyof typeof shPrices]
          ) {
            items.push({ id: item.id, price: shPrices[writeKey] });
          } else if (
            item.price.id ===
            shPrices[`${priorTierKey}-read` as keyof typeof shPrices]
          ) {
            items.push({ id: item.id, price: shPrices[readKey] });
          } else {
            items.push({ id: item.id, price: item.price.id });
          }
        }
      } else {
        const cloudPrices = prices.cloud;
        const writeKey = `${tierKey}-write` as keyof typeof cloudPrices;
        const readKey = `${tierKey}-read` as keyof typeof cloudPrices;

        if (!cloudPrices[writeKey] && !cloudPrices[readKey]) {
          Logger.warn(
            `[Billing] No Stripe prices found for tier ${newTier}, cannot update subscription`,
          );
        }

        for (const item of sub.items.data) {
          if (item.price.id === cloudPrices[`${priorTierKey}-write`]) {
            items.push({ id: item.id, price: cloudPrices[writeKey] });
          } else if (
            item.price.id === cloudPrices[`${priorTierKey}-read`]
          ) {
            items.push({ id: item.id, price: cloudPrices[readKey] });
          } else {
            items.push({ id: item.id, price: item.price.id });
          }
        }
      }

      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        items,
        proration_behavior: "none",
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
  const existingOrgId = session.metadata?.existingOrgId;

  // Resubscribe flow — reactivate an existing CANCELED org
  if (existingOrgId) {
    return handleResubscribe(session, existingOrgId);
  }

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
  const isSelfHosted = session.metadata?.selfHosted === "true";

  // Create the org now that checkout succeeded
  const org = await db.org.create({
    data: {
      name: orgName,
      selfHosted: isSelfHosted,
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscriptionId ?? undefined,
      subscriptionStatus: useTrial ? "TRIAL" : "ACTIVE",
      subscriptionTier: tier,
    },
  });

  // Sync billing cycle anchor from the Stripe subscription
  if (subscriptionId) {
    try {
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (sub.billing_cycle_anchor) {
        const anchorDate = new Date(sub.billing_cycle_anchor * 1000);
        await db.org.update({
          where: { id: org.id },
          data: { billingCycleAnchor: anchorDate.getUTCDate() },
        });
      }
    } catch (err: unknown) {
      Logger.warn(
        `[Stripe Webhook] Failed to sync billing cycle anchor for org ${org.id}: ${String(err)}`,
      );
    }
  }

  // Add the user as admin
  await db.orgUser.create({
    data: {
      orgId: org.id,
      userId,
      role: "ADMIN",
    },
  });

  // Create org directory in storage (cloud only)
  if (!isSelfHosted) {
    try {
      await createOrgDirectory(org.id);
    } catch (error: any) {
      Logger.error(
        `[Stripe Webhook] Failed to create org directory for ${org.id}: ${JSON.stringify(error)}`,
      );
    }
  }

  // Start trial if requested (cloud only — self-hosted is not eligible)
  if (useTrial && !isSelfHosted) {
    try {
      await startTrial(org.id, userId, db, tier);
    } catch (err: any) {
      Logger.warn(
        `[Stripe Webhook] Failed to start trial for org ${org.id}: ${JSON.stringify(err)}`,
      );
    }
  }

  // Auto-generate license for self-hosted orgs
  if (isSelfHosted) {
    try {
      const key = "lic_" + crypto.randomBytes(16).toString("hex");
      const secret = "sec_" + crypto.randomBytes(32).toString("hex");
      const secretHash = crypto
        .createHash("sha256")
        .update(secret)
        .digest("hex");

      await db.license.create({
        data: {
          key,
          secretHash,
          tier,
          orgId: org.id,
        },
      });

      Logger.info(
        `[Stripe Webhook] Created license for self-hosted org "${orgName}" (${org.id})`,
      );
    } catch (err: any) {
      Logger.error(
        `[Stripe Webhook] Failed to create license for self-hosted org ${org.id}: ${JSON.stringify(err)}`,
      );
    }
  }

  Logger.info(
    `[Stripe Webhook] Checkout completed — created org "${orgName}" (${org.id}), subscription ${subscriptionId ?? "none"}, tier ${tier}`,
  );
}

async function handleResubscribe(
  session: Stripe.Checkout.Session,
  orgId: string,
): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    Logger.warn(
      "[Stripe Webhook] resubscribe checkout missing userId metadata",
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

  // Reactivate the existing org with new subscription
  await db.org.update({
    where: { id: orgId },
    data: {
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscriptionId ?? undefined,
      subscriptionStatus: "ACTIVE",
      subscriptionTier: tier,
      canceledAt: null,
      suspendedAt: null,
      delinquentSince: null,
      scheduledTier: null,
      scheduledTierAt: null,
    },
  });

  // Sync billing cycle anchor from the new Stripe subscription
  if (subscriptionId) {
    try {
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (sub.billing_cycle_anchor) {
        const anchorDate = new Date(sub.billing_cycle_anchor * 1000);
        await db.org.update({
          where: { id: orgId },
          data: { billingCycleAnchor: anchorDate.getUTCDate() },
        });
      }
    } catch (err: unknown) {
      Logger.warn(
        `[Stripe Webhook] Failed to sync billing cycle anchor for resubscribed org ${orgId}: ${String(err)}`,
      );
    }
  }

  // Update licenses to new tier
  await db.license.updateMany({
    where: { orgId },
    data: { tier },
  });

  Logger.info(
    `[Stripe Webhook] Resubscribe completed — org ${orgId} reactivated with subscription ${subscriptionId ?? "none"}, tier ${tier}`,
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

  // Find the org for this invoice
  const org = customerId
    ? await db.org.findFirst({
        where: { stripeCustomerId: customerId },
        select: { id: true, subscriptionStatus: true },
      })
    : null;

  // Try to find our local invoice by Stripe invoice ID
  const localInvoice = await db.invoice.findUnique({
    where: { stripeInvoiceId },
  });

  // Extract minimum-due charges and add as credit
  if (org) {
    const prices = getStripePriceConfig();
    const minimumDuePriceId = prices.cloud["minimum-due"];
    let minimumDueCents = 0;

    if (minimumDuePriceId && invoice.lines?.data) {
      for (const line of invoice.lines.data) {
        const priceRef = line.pricing?.price_details?.price;
        const priceId =
          typeof priceRef === "string" ? priceRef : priceRef?.id;
        if (priceId === minimumDuePriceId && line.amount > 0) {
          minimumDueCents += line.amount;
        }
      }
    }

    if (minimumDueCents > 0) {
      await addCredits(
        org.id,
        minimumDueCents,
        `Minimum-due credit from invoice ${stripeInvoiceId}`,
        db,
      );
      Logger.info(
        `[Stripe Webhook] Added ${minimumDueCents}c minimum-due credit for org ${org.id}`,
      );
    }
  }

  if (localInvoice) {
    // Record credit applied from Stripe Customer Balance
    const creditAppliedCents = Math.max(
      0,
      invoice.subtotal - invoice.amount_due,
    );

    await db.invoice.update({
      where: { id: localInvoice.id },
      data: {
        status: "PAID",
        paidAt: new Date(),
        creditAppliedCents,
      },
    });

    // Clear delinquency if all invoices are now paid
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
  } else if (customerId && invoice.total > 0 && org) {
    // Stripe-generated invoice we don't track locally — create a local record
    const periodStart = invoice.period_start
      ? new Date(invoice.period_start * 1000)
      : new Date();
    const creditAppliedCents = Math.max(
      0,
      invoice.subtotal - invoice.amount_due,
    );
    await db.invoice.create({
      data: {
        orgId: org.id,
        stripeInvoiceId,
        year: periodStart.getUTCFullYear(),
        month: periodStart.getUTCMonth() + 1,
        status: "PAID",
        subtotalCents: invoice.subtotal,
        creditAppliedCents,
        minimumDueAddedCents: 0,
        totalCents: invoice.total,
        paidAt: new Date(),
      },
    });
  }
}

/**
 * When an invoice is finalized, sync the Stripe Customer Balance back to our
 * local cache. Stripe may have auto-applied balance to reduce the invoice.
 */
async function handleInvoiceFinalized(
  invoice: Stripe.Invoice,
): Promise<void> {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return;

  const org = await db.org.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  if (!org) return;

  // Sync credit balance cache from Stripe
  await syncCreditBalance(org.id, customerId, db);

  Logger.debug(
    `[Stripe Webhook] Invoice ${invoice.id} finalized — synced credit balance for org ${org.id}`,
  );
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
    select: { id: true, subscriptionStatus: true },
  });
  if (!org) return;

  // Sync trial end date and billing cycle anchor from Stripe
  const updateData: Record<string, unknown> = {};

  if (subscription.trial_end) {
    updateData.trialEndsAt = new Date(subscription.trial_end * 1000);
  }
  if (subscription.billing_cycle_anchor) {
    const anchorDate = new Date(subscription.billing_cycle_anchor * 1000);
    updateData.billingCycleAnchor = anchorDate.getUTCDate();
  }

  if (
    (org.subscriptionStatus === "PAST_DUE" ||
      org.subscriptionStatus === "SUSPENDED") &&
    subscription.status === "active"
  ) {
    updateData.subscriptionStatus = "ACTIVE";
    updateData.canceledAt = null;
    updateData.suspendedAt = null;
    updateData.delinquentSince = null;
  }

  if (Object.keys(updateData).length > 0) {
    await db.org.update({
      where: { id: org.id },
      data: updateData,
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
    select: { id: true, name: true },
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

  const admins = await db.orgUser.findMany({
    where: {
      orgId: org.id,
      role: { in: ["ADMIN", "BILLING"] },
    },
    include: { user: { select: { email: true } } },
  });

  for (const admin of admins) {
    try {
      const template = accountDeletionWarningEmail(
        org.name,
        config.get<number>("stripe.delinquency.delete-after-days"),
        `/${org.name}/settings/billing`,
      );

      await sendEmail({
        to: admin.user.email,
        ...template,
      });
    } catch (err: any) {
      Logger.warn(
        `[Billing] Failed to send cancellation email to ${admin.user.email}: ${JSON.stringify(err)}`,
      );
    }
  }

  Logger.info(
    `[Stripe Webhook] Subscription ${subscription.id} deleted — org ${org.id} set to CANCELED`,
  );
}
