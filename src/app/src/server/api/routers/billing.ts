import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { isLicenseManager } from "~/server/license-utils";
import {
  isStripeEnabled,
  getStripeClient,
  getStripePublishableKey,
  getStripeEnvironment,
  getStripePriceConfig,
  getTrialDurationDays,
} from "~/server/stripe/client";
import {
  getCreditBalance,
  cancelSubscription,
  resumeSubscription,
  startTrial,
} from "~/server/billing";
import { Logger } from "~/server/logging";

function assertBillingEnabled() {
  if (!isLicenseManager() || !isStripeEnabled()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Billing is not available on this instance",
    });
  }
}

function assertBillingRole(role: string) {
  if (role !== "ADMIN" && role !== "BILLING") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only ADMIN or BILLING users can manage billing",
    });
  }
}

export const billingRouter = createTRPCRouter({
  /** Get checkout settings for the frontend. */
  getCheckoutSettings: protectedProcedure.query(() => {
    if (!isLicenseManager()) {
      return { enabled: false, publishableKey: "", environment: "sandbox" };
    }
    return {
      enabled: isStripeEnabled(),
      publishableKey: getStripePublishableKey(),
      environment: getStripeEnvironment(),
    };
  }),

  /** Create a Stripe Checkout Session for org subscription setup. */
  createCheckoutSession: protectedProcedure
    .input(
      z.object({
        orgName: z.string().min(1),
        tier: z.enum(["BASIC", "PRO", "STUDIO"]),
        useTrial: z.boolean().default(false),
        successUrl: z.string(),
        cancelUrl: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertBillingEnabled();

      const stripe = getStripeClient();

      // Create Stripe Customer upfront (org doesn't exist yet)
      const customer = await stripe.customers.create({
        name: input.orgName,
        email: ctx.session.user.email ?? undefined,
        metadata: { orgName: input.orgName },
      });

      const prices = getStripePriceConfig();

      // Build line items for metered prices
      const tierKey = input.tier.toLowerCase() as "basic" | "pro" | "studio";
      const lineItems: Array<{ price: string }> = [];

      const cloudPrices = prices.cloud;
      const writeKey = `${tierKey}-write` as keyof typeof cloudPrices;
      const readKey = `${tierKey}-read` as keyof typeof cloudPrices;

      if (cloudPrices[writeKey])
        lineItems.push({ price: cloudPrices[writeKey] });
      if (cloudPrices[readKey]) lineItems.push({ price: cloudPrices[readKey] });
      if (cloudPrices.storage) lineItems.push({ price: cloudPrices.storage });
      if (cloudPrices["minimum-due"])
        lineItems.push({ price: cloudPrices["minimum-due"] });

      const sessionParams: Parameters<
        typeof stripe.checkout.sessions.create
      >[0] = {
        customer: customer.id,
        mode: "subscription",
        line_items: lineItems,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        managed_payments: { enabled: true },
        metadata: {
          orgName: input.orgName,
          tier: input.tier,
          useTrial: String(input.useTrial),
          userId: ctx.session.user.id,
        },
      };

      if (input.useTrial) {
        sessionParams.subscription_data = {
          trial_period_days: getTrialDurationDays(),
          metadata: {
            orgName: input.orgName,
            tier: input.tier,
            userId: ctx.session.user.id,
          },
        };
      } else {
        sessionParams.subscription_data = {
          metadata: {
            orgName: input.orgName,
            tier: input.tier,
            userId: ctx.session.user.id,
          },
        };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      Logger.info(
        `[Billing] Created Checkout Session ${session.id} for org "${input.orgName}" (${input.tier})`,
      );

      return { checkoutUrl: session.url };
    }),

  /** Get billing info for an org. */
  getBillingInfo: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const org = await ctx.db.org.findUniqueOrThrow({
        where: { id: input.orgId },
        select: {
          subscriptionTier: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          canceledAt: true,
          delinquentSince: true,
          creditBalanceCents: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          scheduledTier: true,
          scheduledTierAt: true,
        },
      });

      // Fetch current_period_end from Stripe subscription items
      let currentPeriodEnd: string | null = null;
      if (isStripeEnabled() && org.stripeSubscriptionId) {
        try {
          const stripe = getStripeClient();
          const sub = await stripe.subscriptions.retrieve(
            org.stripeSubscriptionId,
          );
          const firstItem = sub.items.data[0];
          if (firstItem?.current_period_end) {
            currentPeriodEnd = new Date(
              firstItem.current_period_end * 1000,
            ).toISOString();
          }
        } catch {
          // Non-critical — continue without period end
        }
      }

      return {
        tier: org.subscriptionTier,
        status: org.subscriptionStatus,
        trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
        canceledAt: org.canceledAt?.toISOString() ?? null,
        delinquentSince: org.delinquentSince?.toISOString() ?? null,
        creditBalanceCents: org.creditBalanceCents,
        hasStripeCustomer: !!org.stripeCustomerId,
        scheduledTier: org.scheduledTier,
        scheduledTierAt: org.scheduledTierAt?.toISOString() ?? null,
        currentPeriodEnd,
      };
    }),

  /** Get paginated invoices for an org. */
  getInvoices: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const invoices = await ctx.db.invoice.findMany({
        where: { orgId: input.orgId },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        include: { items: true },
      });

      let nextCursor: string | undefined;
      if (invoices.length > input.limit) {
        const next = invoices.pop()!;
        nextCursor = next.id;
      }

      return { invoices, nextCursor };
    }),

  /** Get detailed invoice with line items. */
  getInvoiceDetail: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const invoice = await ctx.db.invoice.findUniqueOrThrow({
        where: { id: input.invoiceId },
        include: { items: true, org: { select: { name: true } } },
      });

      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: invoice.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      return invoice;
    }),

  /** Cancel subscription (or trial). */
  cancelSubscription: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertBillingEnabled();

      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) throw new TRPCError({ code: "FORBIDDEN" });
      assertBillingRole(orgUser.role);

      await cancelSubscription(input.orgId, ctx.db);
      return { success: true };
    }),

  /** Resume a suspended/canceled subscription. */
  resumeSubscription: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertBillingEnabled();

      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) throw new TRPCError({ code: "FORBIDDEN" });
      assertBillingRole(orgUser.role);

      return await resumeSubscription(input.orgId, ctx.db);
    }),

  /** Change subscription tier. */
  changeTier: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
        tier: z.enum(["BASIC", "PRO", "STUDIO"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertBillingEnabled();

      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) throw new TRPCError({ code: "FORBIDDEN" });
      assertBillingRole(orgUser.role);

      const org = await ctx.db.org.findUniqueOrThrow({
        where: { id: input.orgId },
        select: {
          stripeSubscriptionId: true,
          subscriptionTier: true,
          subscriptionStatus: true,
        },
      });

      const tierOrder = { BASIC: 0, PRO: 1, STUDIO: 2, INCANTA: 3 };
      const currentRank = tierOrder[org.subscriptionTier] ?? 0;
      const newRank = tierOrder[input.tier] ?? 0;
      const isDowngrade = newRank < currentRank;
      const isTrial = org.subscriptionStatus === "TRIAL";

      // Downgrade while not in trial → schedule for end of billing period
      if (isDowngrade && !isTrial) {
        let scheduledAt: Date | null = null;
        if (isStripeEnabled() && org.stripeSubscriptionId) {
          try {
            const stripe = getStripeClient();
            const sub = await stripe.subscriptions.retrieve(
              org.stripeSubscriptionId,
            );
            const firstItem = sub.items.data[0];
            if (firstItem?.current_period_end) {
              scheduledAt = new Date(firstItem.current_period_end * 1000);
            }
          } catch (err: any) {
            Logger.warn(
              `[Billing] Failed to fetch subscription period end: ${JSON.stringify(err)}`,
            );
          }
        }

        await ctx.db.org.update({
          where: { id: input.orgId },
          data: {
            scheduledTier: input.tier,
            scheduledTierAt: scheduledAt,
          },
        });

        Logger.info(
          `[Billing] Scheduled downgrade to ${input.tier} for org ${input.orgId} (effective ${scheduledAt?.toISOString() ?? "end of period"})`,
        );
        return { success: true, tier: input.tier, scheduled: true };
      }

      // Upgrade or trial downgrade → apply immediately
      if (isStripeEnabled() && org.stripeSubscriptionId) {
        try {
          const stripe = getStripeClient();
          const sub = await stripe.subscriptions.retrieve(
            org.stripeSubscriptionId,
          );
          const prices = getStripePriceConfig();
          const tierKey = input.tier.toLowerCase() as
            | "basic"
            | "pro"
            | "studio";
          const cloudPrices = prices.cloud;
          const writeKey = `${tierKey}-write` as keyof typeof cloudPrices;
          const readKey = `${tierKey}-read` as keyof typeof cloudPrices;

          // Replace subscription items with new tier's prices
          const items: Array<{
            id?: string;
            price?: string;
            deleted?: boolean;
          }> = [];
          for (const item of sub.items.data) {
            items.push({ id: item.id, deleted: true });
          }
          if (cloudPrices[writeKey])
            items.push({ price: cloudPrices[writeKey] });
          if (cloudPrices[readKey]) items.push({ price: cloudPrices[readKey] });
          if (cloudPrices.storage) items.push({ price: cloudPrices.storage });
          if (cloudPrices["minimum-due"])
            items.push({ price: cloudPrices["minimum-due"] });

          await stripe.subscriptions.update(org.stripeSubscriptionId, {
            items,
            metadata: { tier: input.tier },
          });
        } catch (err: any) {
          Logger.warn(
            `[Billing] Failed to update Stripe subscription tier: ${JSON.stringify(err)}`,
          );
        }
      }

      await ctx.db.org.update({
        where: { id: input.orgId },
        data: {
          subscriptionTier: input.tier,
          scheduledTier: null,
          scheduledTierAt: null,
        },
      });

      await ctx.db.license.updateMany({
        where: { orgId: input.orgId },
        data: { tier: input.tier },
      });

      Logger.info(
        `[Billing] Tier changed to ${input.tier} for org ${input.orgId}`,
      );
      return { success: true, tier: input.tier, scheduled: false };
    }),

  /** Cancel a scheduled tier change. */
  cancelScheduledChange: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertBillingEnabled();

      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) throw new TRPCError({ code: "FORBIDDEN" });
      assertBillingRole(orgUser.role);

      await ctx.db.org.update({
        where: { id: input.orgId },
        data: { scheduledTier: null, scheduledTierAt: null },
      });

      Logger.info(
        `[Billing] Scheduled tier change canceled for org ${input.orgId}`,
      );
      return { success: true };
    }),

  /** Start a free trial for the org. */
  startTrial: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertBillingEnabled();

      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) throw new TRPCError({ code: "FORBIDDEN" });
      assertBillingRole(orgUser.role);

      const result = await startTrial(input.orgId, ctx.session.user.id, ctx.db);

      if (!result.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.error,
        });
      }

      return result;
    }),

  /** Get Stripe Billing Portal URL for the org's customer. */
  getPaymentUpdateUrl: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertBillingEnabled();

      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (!orgUser) throw new TRPCError({ code: "FORBIDDEN" });
      assertBillingRole(orgUser.role);

      const org = await ctx.db.org.findUniqueOrThrow({
        where: { id: input.orgId },
        select: { stripeCustomerId: true },
      });

      if (!org.stripeCustomerId) {
        return { url: null };
      }

      try {
        const stripe = getStripeClient();
        const session = await stripe.billingPortal.sessions.create({
          customer: org.stripeCustomerId,
          return_url: `${ctx.headers.get("origin") ?? ""}/${input.orgId}/settings/billing`,
        });
        return { url: session.url };
      } catch (err: any) {
        Logger.warn(
          `[Billing] Failed to create billing portal session: ${JSON.stringify(err)}`,
        );
        return { url: null };
      }
    }),

  /** Check if the current user has used their free trial. */
  getTrialStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { trialUsed: true },
    });
    return { trialUsed: user.trialUsed };
  }),
});
