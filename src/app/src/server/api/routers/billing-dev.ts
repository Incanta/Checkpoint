import { z } from "zod";
import { TRPCError } from "@trpc/server";
import config from "@incanta/config";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { Logger } from "~/server/logging";
import {
  getSchedulerState,
  runBillingChecks,
} from "~/server/billing/scheduler";
import { reportOrgUserMeters, reportOrgStorageMeters } from "~/server/billing/meter-reporting";
import { calculateStorageCharge } from "~/server/billing/storage-usage";
import { checkTrialExpiry } from "~/server/billing/trial";
import { checkDelinquency } from "~/server/billing/delinquency";

function assertDevMode() {
  const allowDev = config.tryGet<boolean>("auth.dev.allow-dev-login");
  if (!allowDev) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Dev billing tools are only available when dev login is enabled",
    });
  }
}

export const billingDevRouter = createTRPCRouter({
  /** Get current scheduler state. */
  getSchedulerState: protectedProcedure.query(() => {
    assertDevMode();
    const state = getSchedulerState();
    return {
      lastDailyRun: state.lastDailyRun,
      isRunning: state.intervalId !== null,
    };
  }),

  /** Reset scheduler dedup state so ticks can re-run. */
  resetSchedulerState: protectedProcedure.mutation(() => {
    assertDevMode();
    const state = getSchedulerState();
    state.lastDailyRun = null;
    Logger.info("[BillingDev] Scheduler state reset");
    return { success: true };
  }),

  /** Trigger meter reporting for a single org or all orgs. */
  triggerMeterReport: protectedProcedure
    .input(
      z
        .object({
          orgId: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      assertDevMode();

      if (input?.orgId) {
        const org = await ctx.db.org.findUniqueOrThrow({
          where: { id: input.orgId },
          select: { id: true, name: true, stripeCustomerId: true },
        });
        if (!org.stripeCustomerId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Org has no Stripe customer ID",
          });
        }

        const storage = await calculateStorageCharge(org.id, ctx.db);
        await reportOrgStorageMeters(
          org.id,
          org.stripeCustomerId,
          storage.buckets,
          ctx.db,
        );
        await reportOrgUserMeters(org.id, ctx.db);

        Logger.info(
          `[BillingDev] Meter report triggered for org ${org.name}`,
        );
        return { orgId: org.id, storageBuckets: storage.buckets };
      }

      // All orgs
      const orgs = await ctx.db.org.findMany({
        where: {
          subscriptionStatus: { in: ["ACTIVE", "TRIAL", "PAST_DUE"] },
          stripeCustomerId: { not: null },
          deletedAt: null,
        },
        select: { id: true, name: true, stripeCustomerId: true },
      });

      let success = 0;
      for (const org of orgs) {
        if (!org.stripeCustomerId) continue;
        try {
          const storage = await calculateStorageCharge(org.id, ctx.db);
          await reportOrgStorageMeters(
            org.id,
            org.stripeCustomerId,
            storage.buckets,
            ctx.db,
          );
          await reportOrgUserMeters(org.id, ctx.db);
          success++;
        } catch {
          // continue with next org
        }
      }

      Logger.info(
        `[BillingDev] Meter report triggered for ${success}/${orgs.length} orgs`,
      );
      return { reported: success, total: orgs.length };
    }),

  /** Trigger all daily checks immediately. */
  triggerDailyChecks: protectedProcedure.mutation(async () => {
    assertDevMode();
    await runBillingChecks(new Date());
    Logger.info("[BillingDev] Daily checks triggered");
    return { success: true };
  }),

  /** Trigger trial expiry check. */
  triggerTrialExpiry: protectedProcedure.mutation(async ({ ctx }) => {
    assertDevMode();
    await checkTrialExpiry(ctx.db);
    Logger.info("[BillingDev] Trial expiry check triggered");
    return { success: true };
  }),

  /** Trigger delinquency check. */
  triggerDelinquencyCheck: protectedProcedure.mutation(async ({ ctx }) => {
    assertDevMode();
    await checkDelinquency(ctx.db);
    Logger.info("[BillingDev] Delinquency check triggered");
    return { success: true };
  }),

  /** Override date fields on an org to simulate time passing. */
  setOrgDates: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
        trialEndsAt: z.string().datetime().nullable().optional(),
        delinquentSince: z.string().datetime().nullable().optional(),
        suspendedAt: z.string().datetime().nullable().optional(),
        canceledAt: z.string().datetime().nullable().optional(),
        subscriptionStatus: z
          .enum(["ACTIVE", "TRIAL", "PAST_DUE", "SUSPENDED", "CANCELED"])
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertDevMode();

      const data: Record<string, unknown> = {};
      if (input.trialEndsAt !== undefined) {
        data.trialEndsAt = input.trialEndsAt
          ? new Date(input.trialEndsAt)
          : null;
      }
      if (input.delinquentSince !== undefined) {
        data.delinquentSince = input.delinquentSince
          ? new Date(input.delinquentSince)
          : null;
      }
      if (input.suspendedAt !== undefined) {
        data.suspendedAt = input.suspendedAt
          ? new Date(input.suspendedAt)
          : null;
      }
      if (input.canceledAt !== undefined) {
        data.canceledAt = input.canceledAt ? new Date(input.canceledAt) : null;
      }
      if (input.subscriptionStatus !== undefined) {
        data.subscriptionStatus = input.subscriptionStatus;
      }

      const org = await ctx.db.org.update({
        where: { id: input.orgId },
        data,
        select: {
          id: true,
          name: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          delinquentSince: true,
          suspendedAt: true,
          canceledAt: true,
        },
      });

      Logger.info(`[BillingDev] Updated org dates: ${JSON.stringify(org)}`);
      return org;
    }),

  /** Override invoice status for testing. */
  setInvoiceStatus: protectedProcedure
    .input(
      z.object({
        invoiceId: z.string(),
        status: z.enum(["DRAFT", "ISSUED", "PAID", "FAILED", "HELD"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertDevMode();

      const data: Record<string, unknown> = { status: input.status };
      if (input.status === "PAID") data.paidAt = new Date();
      if (input.status === "FAILED") data.failedAt = new Date();
      if (input.status === "ISSUED") data.issuedAt = new Date();
      if (input.status === "HELD") data.heldAt = new Date();

      const invoice = await ctx.db.invoice.update({
        where: { id: input.invoiceId },
        data,
        select: {
          id: true,
          orgId: true,
          year: true,
          month: true,
          status: true,
          totalCents: true,
        },
      });

      Logger.info(
        `[BillingDev] Invoice ${invoice.id} status set to ${input.status}`,
      );
      return invoice;
    }),

  /** List all orgs with billing info for dev tools. */
  listOrgs: protectedProcedure.query(async ({ ctx }) => {
    assertDevMode();
    return ctx.db.org.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        subscriptionStatus: true,
        subscriptionTier: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        trialEndsAt: true,
        delinquentSince: true,
        suspendedAt: true,
        canceledAt: true,
        creditBalanceCents: true,
      },
      orderBy: { name: "asc" },
    });
  }),

  /** List invoices for an org. */
  listInvoices: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertDevMode();
      return ctx.db.invoice.findMany({
        where: { orgId: input.orgId },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        include: { items: true },
      });
    }),
});
