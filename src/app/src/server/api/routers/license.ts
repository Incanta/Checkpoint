import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import {
  isLicenseManager,
  hasFeature,
  getFeaturesForTier,
  type LicenseFeature,
  type LicenseTier,
  LicenseFeatures,
} from "~/server/license-utils";
import { getEffectiveTier as getEffectiveTierHelper } from "~/server/license-client";

export const licenseRouter = createTRPCRouter({
  // Admin: list all licenses (license manager only)
  list: protectedProcedure
    .input(
      z
        .object({
          includeInactive: z.boolean().default(false),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      if (!isLicenseManager()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a license manager instance",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      if (!user?.checkpointAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
      }

      return ctx.db.license.findMany({
        where: input?.includeInactive ? {} : { active: true },
        include: {
          org: { select: { id: true, name: true } },
          _count: { select: { usageReports: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }),

  // Admin: get a single license with usage reports
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      if (!isLicenseManager()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a license manager instance",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      if (!user?.checkpointAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
      }

      return ctx.db.license.findUnique({
        where: { id: input.id },
        include: {
          org: { select: { id: true, name: true } },
          usageReports: {
            orderBy: [{ year: "desc" }, { month: "desc" }],
            take: 12,
          },
        },
      });
    }),

  // Admin: create a new license
  create: protectedProcedure
    .input(
      z.object({
        tier: z.enum(["BASIC", "PRO", "STUDIO", "INCANTA"]),
        orgId: z.string().optional(),
        instanceName: z.string().optional(),
        instanceUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isLicenseManager()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a license manager instance",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      if (!user?.checkpointAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
      }

      const key = "lic_" + crypto.randomBytes(16).toString("hex");
      const secret = "sec_" + crypto.randomBytes(32).toString("hex");
      const secretHash = crypto
        .createHash("sha256")
        .update(secret)
        .digest("hex");

      const license = await ctx.db.license.create({
        data: {
          key,
          secretHash,
          tier: input.tier,
          orgId: input.orgId,
          instanceName: input.instanceName,
          instanceUrl: input.instanceUrl,
        },
      });

      // If this is a cloud license linked to an org, sync the org's tier
      if (input.orgId) {
        await ctx.db.org.update({
          where: { id: input.orgId },
          data: { subscriptionTier: input.tier },
        });
      }

      // Return the secret only on creation
      return { ...license, secret };
    }),

  // Admin: update a license
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        tier: z.enum(["BASIC", "PRO", "STUDIO", "INCANTA"]).optional(),
        active: z.boolean().optional(),
        instanceName: z.string().optional(),
        instanceUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isLicenseManager()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a license manager instance",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      if (!user?.checkpointAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
      }

      const { id, ...updateData } = input;

      const license = await ctx.db.license.update({
        where: { id },
        data: updateData,
      });

      // Sync org tier if this is a cloud license
      if (license.orgId && input.tier) {
        await ctx.db.org.update({
          where: { id: license.orgId },
          data: { subscriptionTier: input.tier },
        });
      }

      return license;
    }),

  // Admin: revoke a license
  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!isLicenseManager()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a license manager instance",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      if (!user?.checkpointAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
      }

      return ctx.db.license.update({
        where: { id: input.id },
        data: { active: false },
      });
    }),

  // Admin: get usage reports for a license
  getUsageReports: protectedProcedure
    .input(
      z.object({
        licenseId: z.string(),
        limit: z.number().min(1).max(100).default(12),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!isLicenseManager()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a license manager instance",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      if (!user?.checkpointAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
      }

      return ctx.db.licenseUsageReport.findMany({
        where: { licenseId: input.licenseId },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        take: input.limit,
      });
    }),

  // Public: get the effective tier for an org
  getEffectiveTier: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ tier: LicenseTier; features: LicenseFeature[] }> => {
        const tier = await getEffectiveTierHelper(input.orgId, ctx.db);
        return { tier, features: getFeaturesForTier(tier) };
      },
    ),

  // Public: check if a specific feature is available
  checkFeature: publicProcedure
    .input(
      z.object({
        orgId: z.string(),
        feature: z.enum(LicenseFeatures),
      }),
    )
    .query(async ({ ctx, input }): Promise<boolean> => {
      const tier = await getEffectiveTierHelper(input.orgId, ctx.db);
      return hasFeature(tier, input.feature);
    }),

  // Org member: get license info for a self-hosted org
  getLicenseInfo: protectedProcedure
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
        select: { selfHosted: true },
      });
      if (!org.selfHosted) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Not a self-hosted organization",
        });
      }

      const license = await ctx.db.license.findFirst({
        where: { orgId: input.orgId },
        select: {
          id: true,
          key: true,
          tier: true,
          active: true,
          createdAt: true,
          lastReportAt: true,
        },
      });

      if (!license) return null;

      // Get recent usage reports
      const usageReports = await ctx.db.licenseUsageReport.findMany({
        where: { licenseId: license.id },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        take: 12,
      });

      return { ...license, usageReports };
    }),

  // Org admin: regenerate license secret
  regenerateSecret: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findUnique({
        where: {
          orgId_userId: { orgId: input.orgId, userId: ctx.session.user.id },
        },
      });
      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
      }

      const org = await ctx.db.org.findUniqueOrThrow({
        where: { id: input.orgId },
        select: { selfHosted: true },
      });
      if (!org.selfHosted) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Not a self-hosted organization",
        });
      }

      const license = await ctx.db.license.findFirst({
        where: { orgId: input.orgId },
      });
      if (!license) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No license found for this organization",
        });
      }

      const secret = "sec_" + crypto.randomBytes(32).toString("hex");
      const secretHash = crypto
        .createHash("sha256")
        .update(secret)
        .digest("hex");

      await ctx.db.license.update({
        where: { id: license.id },
        data: { secretHash },
      });

      // Return the new secret — this is the only time it can be viewed
      return { secret };
    }),
});
