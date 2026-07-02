import { z } from "zod";
import { TRPCError } from "@trpc/server";
import config from "@incanta/config";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { isLicenseManager } from "~/server/license-utils";
import {
  isStripeEnabled,
  getStripeClient,
  getStripePublishableKey,
  getStripeEnvironment,
  getStripePriceConfig,
  getStoragePricingConfig,
  getMinimumInvoiceCents,
} from "~/server/stripe/client";
import {
  cancelSubscription,
  resumeSubscription,
  startTrial,
  calculateStorageCharge,
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
      const minInvoice = getMinimumInvoiceCents();

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
      if (minInvoice !== null && cloudPrices["minimum-due"])
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

      sessionParams.subscription_data = {
        metadata: {
          orgName: input.orgName,
          tier: input.tier,
          userId: ctx.session.user.id,
        },
      };

      const session = await stripe.checkout.sessions.create(sessionParams);

      Logger.info(
        `[Billing] Created Checkout Session ${session.id} for org "${input.orgName}" (${input.tier})`,
      );

      return { checkoutUrl: session.url };
    }),

  /** Create a Stripe Checkout Session to resubscribe a CANCELED org. */
  resubscribe: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
        tier: z.enum(["BASIC", "PRO", "STUDIO"]),
        successUrl: z.string(),
        cancelUrl: z.string(),
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
          id: true,
          name: true,
          subscriptionStatus: true,
          stripeCustomerId: true,
        },
      });

      if (org.subscriptionStatus !== "CANCELED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only canceled organizations can resubscribe",
        });
      }

      const stripe = getStripeClient();

      // Reuse existing Stripe customer or create a new one
      let customerId = org.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          name: org.name,
          email: ctx.session.user.email ?? undefined,
          metadata: { orgName: org.name, orgId: org.id },
        });
        customerId = customer.id;
      }

      const prices = getStripePriceConfig();
      const minInvoice = getMinimumInvoiceCents();
      const tierKey = input.tier.toLowerCase() as "basic" | "pro" | "studio";
      const lineItems: Array<{ price: string }> = [];

      // Cloud: write/read + storage + minimum-due
      const cloudPrices = prices.cloud;
      const writeKey = `${tierKey}-write` as keyof typeof cloudPrices;
      const readKey = `${tierKey}-read` as keyof typeof cloudPrices;
      if (cloudPrices[writeKey]) lineItems.push({ price: cloudPrices[writeKey] });
      if (cloudPrices[readKey]) lineItems.push({ price: cloudPrices[readKey] });
      if (cloudPrices.storage) lineItems.push({ price: cloudPrices.storage });
      if (minInvoice !== null && cloudPrices["minimum-due"])
        lineItems.push({ price: cloudPrices["minimum-due"] });

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: lineItems,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        managed_payments: { enabled: true },
        metadata: {
          existingOrgId: org.id,
          tier: input.tier,
          userId: ctx.session.user.id,
        },
        subscription_data: {
          metadata: {
            orgName: org.name,
            tier: input.tier,
            userId: ctx.session.user.id,
          },
        },
      });

      Logger.info(
        `[Billing] Created resubscribe Checkout Session ${session.id} for org "${org.name}" (${org.id}, ${input.tier})`,
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

      // Fetch credit balance from Stripe (source of truth)
      let creditBalanceCents = org.creditBalanceCents;
      const minInvoice = getMinimumInvoiceCents();
      if (minInvoice !== null && isStripeEnabled() && org.stripeCustomerId) {
        try {
          const stripe = getStripeClient();
          const customer = await stripe.customers.retrieve(
            org.stripeCustomerId,
          );
          if (!customer.deleted) {
            creditBalanceCents = Math.max(0, -(customer.balance ?? 0));
            // Update local cache if it drifted
            if (creditBalanceCents !== org.creditBalanceCents) {
              await ctx.db.org.update({
                where: { id: input.orgId },
                data: { creditBalanceCents },
              });
            }
          }
        } catch {
          // Non-critical — use cached value
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
        schedule: z.boolean().optional(),
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
      const isUpgrade = newRank > currentRank;
      const isTrial = org.subscriptionStatus === "TRIAL";

      // Schedule for end of billing period (downgrades always, upgrades if requested)
      if ((!isTrial && isDowngrade) || (isUpgrade && input.schedule)) {
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
          `[Billing] Scheduled ${isDowngrade ? "downgrade" : "upgrade"} to ${input.tier} for org ${input.orgId} (effective ${scheduledAt?.toISOString() ?? "end of period"})`,
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
          const priorTierKey = org.subscriptionTier.toLowerCase() as
            | "basic"
            | "pro"
            | "studio";

          // Replace subscription items with new tier's prices
          const items: Array<{
            id?: string;
            price?: string;
            deleted?: boolean;
          }> = [];

          const cloudPrices = prices.cloud;
          const writeKey = `${tierKey}-write` as keyof typeof cloudPrices;
          const readKey = `${tierKey}-read` as keyof typeof cloudPrices;

          if (!cloudPrices[writeKey] && !cloudPrices[readKey]) {
            Logger.warn(
              `[Billing] No Stripe prices found for tier ${input.tier}, cannot update subscription`,
            );
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Pricing configuration error",
            });
          }

          for (const item of sub.items.data) {
            if (item.price.id === cloudPrices[`${priorTierKey}-write`]) {
              items.push({ id: item.id, price: cloudPrices[writeKey] });
            } else if (item.price.id === cloudPrices[`${priorTierKey}-read`]) {
              items.push({ id: item.id, price: cloudPrices[readKey] });
            } else {
              // keep storage and minimum due items unchanged
              items.push({ id: item.id, price: item.price.id });
            }
          }

          await stripe.subscriptions.update(org.stripeSubscriptionId, {
            items,
            proration_behavior: "none",
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
    .input(
      z.object({
        orgId: z.string(),
        tier: z.enum(["BASIC", "PRO", "STUDIO"]).default("BASIC"),
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

      const result = await startTrial(
        input.orgId,
        ctx.session.user.id,
        ctx.db,
        input.tier,
      );

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
          return_url: `${config.get<string>("server.external-url")}/${input.orgId}/settings/billing`,
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

  /** Get storage usage breakdown for an org. */
  getStorageUsage: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: { orgId: input.orgId, userId: ctx.session.user.id },
      });
      if (!orgUser) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not a member" });
      }

      const lm = isLicenseManager();

      const storage = await calculateStorageCharge(input.orgId, ctx.db);

      // Pricing config for capacity display
      let freeGb = 0;
      let bucketSizeGb = 0;
      let billedGB = storage.totalGB;
      let capacityGB = 0;
      if (lm) {
        const pricing = getStoragePricingConfig();
        freeGb = pricing.freeTierGb;
        bucketSizeGb = pricing.bucketSizeGb;
        billedGB = Number(storage.peakBytes) / (1024 * 1024 * 1024);
        capacityGB = freeGb + storage.buckets * bucketSizeGb;
      }

      // Find repos pending R2 cleanup
      const pendingCleanup = await ctx.db.repo.findMany({
        where: {
          orgId: input.orgId,
          deletedAt: { not: null },
          r2BucketName: { not: null },
        },
        select: { id: true, name: true, deletedAt: true },
      });

      return {
        totalBytes: storage.totalBytes,
        totalGB: storage.totalGB,
        peakBytes: storage.peakBytes.toString(),
        billedGB,
        buckets: storage.buckets,
        chargeCents: storage.chargeCents,
        freeGb,
        bucketSizeGb,
        capacityGB,
        isLicenseManager: lm,
        pendingCleanup: pendingCleanup.map((r) => ({
          id: r.id,
          name: r.name,
          deletedAt: r.deletedAt,
        })),
      };
    }),
});
