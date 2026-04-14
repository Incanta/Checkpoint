import { z } from "zod";
import { createTRPCRouter, adminProcedure } from "~/server/api/trpc";
import { snapshotStoragePeak } from "~/server/billing/storage-usage";
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
});
