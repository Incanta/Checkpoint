import { z } from "zod";
import { createTRPCRouter, adminProcedure } from "~/server/api/trpc";
import { snapshotStoragePeak } from "~/server/billing/storage-usage";
import { addCredits, removeCredits, getCreditBalance } from "~/server/billing/credits";
import { Logger } from "~/server/logging";

export const adminRouter = createTRPCRouter({
  getStats: adminProcedure.query(async ({ ctx }) => {
    const [totalUsers, totalOrgs, totalRepos, tierCounts, statusCounts] =
      await Promise.all([
        ctx.db.user.count(),
        ctx.db.org.count({ where: { deletedAt: null } }),
        ctx.db.repo.count({ where: { deletedAt: null } }),
        ctx.db.org.groupBy({
          by: ["subscriptionTier"],
          where: { deletedAt: null },
          _count: true,
        }),
        ctx.db.org.groupBy({
          by: ["subscriptionStatus"],
          where: { deletedAt: null },
          _count: true,
        }),
      ]);

    return {
      totalUsers,
      totalOrgs,
      totalRepos,
      tierCounts: tierCounts.map((t) => ({
        tier: t.subscriptionTier,
        count: t._count,
      })),
      statusCounts: statusCounts.map((s) => ({
        status: s.subscriptionStatus,
        count: s._count,
      })),
    };
  }),

  getDelinquentOrgs: adminProcedure.query(async ({ ctx }) => {
    const orgs = await ctx.db.org.findMany({
      where: {
        OR: [
          {
            subscriptionStatus: {
              in: ["PAST_DUE", "SUSPENDED", "CANCELED", "DELETED"],
            },
          },
          { deletedAt: { not: null } },
        ],
      },
      include: {
        _count: {
          select: {
            users: true,
            repos: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { delinquentSince: { sort: "asc", nulls: "last" } },
    });

    return orgs.map((org) => ({
      id: org.id,
      name: org.name,
      subscriptionStatus: org.subscriptionStatus,
      subscriptionTier: org.subscriptionTier,
      delinquentSince: org.delinquentSince,
      suspendedAt: org.suspendedAt,
      canceledAt: org.canceledAt,
      deletedAt: org.deletedAt,
      memberCount: org._count.users,
      liveRepoCount: org._count.repos,
    }));
  }),

  getOrgRepos: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.repo.findMany({
        where: { orgId: input.orgId },
        select: {
          id: true,
          name: true,
          deletedAt: true,
          deletedBy: true,
          r2BucketName: true,
        },
        orderBy: { name: "asc" },
      });
    }),

  adminDeleteOrgRepos: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.db.org.findUnique({
        where: { id: input.orgId },
        select: { subscriptionStatus: true, deletedAt: true },
      });

      if (
        !org ||
        (org.subscriptionStatus !== "CANCELED" &&
          org.subscriptionStatus !== "DELETED" &&
          !org.deletedAt)
      ) {
        throw new Error(
          "Can only delete repos for CANCELED, DELETED, or soft-deleted orgs",
        );
      }

      // Snapshot peak storage before bulk deletion
      try {
        await snapshotStoragePeak(input.orgId, ctx.db);
      } catch (err: unknown) {
        Logger.warn(
          `[Admin] Failed to snapshot storage peak for org ${input.orgId}: ${String(err)}`,
        );
      }

      const result = await ctx.db.repo.updateMany({
        where: { orgId: input.orgId, deletedAt: null },
        data: {
          deletedAt: new Date(),
          deletedBy: ctx.session.user.id,
        },
      });

      Logger.info(
        `[Admin] Marked ${result.count} repos as deleted for org ${input.orgId} by user ${ctx.session.user.id}`,
      );

      return { deletedCount: result.count };
    }),

  searchOrgs: adminProcedure
    .input(z.object({ query: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const orgs = await ctx.db.org.findMany({
        where: {
          name: { contains: input.query },
        },
        select: {
          id: true,
          name: true,
          subscriptionTier: true,
          subscriptionStatus: true,
          creditBalanceCents: true,
          stripeCustomerId: true,
        },
        take: 10,
        orderBy: { name: "asc" },
      });

      return orgs;
    }),

  getOrgCreditBalance: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      const balance = await getCreditBalance(input.orgId, ctx.db);
      return { creditBalanceCents: balance };
    }),

  adjustCredit: adminProcedure
    .input(
      z.object({
        orgId: z.string(),
        amountCents: z.number().int().positive(),
        action: z.enum(["add", "remove"]),
        description: z.string().min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.db.org.findUniqueOrThrow({
        where: { id: input.orgId },
        select: { name: true },
      });

      const fullDescription = `[Admin: ${ctx.session.user.name ?? ctx.session.user.id}] ${input.description}`;

      if (input.action === "add") {
        await addCredits(input.orgId, input.amountCents, fullDescription, ctx.db);
      } else {
        await removeCredits(input.orgId, input.amountCents, fullDescription, ctx.db);
      }

      const balance = await getCreditBalance(input.orgId, ctx.db);

      Logger.info(
        `[Admin] ${input.action === "add" ? "Added" : "Removed"} ${input.amountCents}c credit for org ${org.name} (${input.orgId}) by ${ctx.session.user.id}: ${input.description}`,
      );

      return { creditBalanceCents: balance };
    }),

  getDailyMetrics: adminProcedure
    .input(
      z
        .object({
          from: z.date().optional(),
          to: z.date().optional(),
          limit: z.number().int().min(1).max(365).default(30),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {};
      if (input?.from || input?.to) {
        const dateFilter: Record<string, Date> = {};
        if (input.from) dateFilter.gte = input.from;
        if (input.to) dateFilter.lte = input.to;
        where.date = dateFilter;
      }

      return ctx.db.dailyMetrics.findMany({
        where,
        orderBy: { date: "desc" },
        take: input?.limit ?? 30,
      });
    }),
});
