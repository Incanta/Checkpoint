import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import { assertFeature } from "~/server/license-client";
import {
  upsertBadge,
  findLatestGoodChangelist,
  type BadgeInput,
} from "~/server/team-sync/badges";

const badgeStateSchema = z.enum([
  "STARTING",
  "FAILURE",
  "WARNING",
  "SUCCESS",
  "SKIPPED",
]);

const badgeFields = z.object({
  name: z.string().min(1).max(100),
  group: z.string().max(100).optional(),
  state: badgeStateSchema,
  url: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

async function assertChangelistExists(
  db: Parameters<typeof upsertBadge>[0],
  repoId: string,
  changelistNumber: number,
): Promise<void> {
  const changelist = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { number: true },
  });
  if (!changelist) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Changelist ${changelistNumber} not found`,
    });
  }
}

export const buildBadgeRouter = createTRPCRouter({
  // Post (upsert) a single build badge. Called by CI service accounts.
  post: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        ...badgeFields.shape,
      }),
    )
    .output(
      z.object({
        id: z.string(),
        previousState: badgeStateSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "teamSync", ctx.db);
      await assertChangelistExists(ctx.db, input.repoId, input.changelistNumber);

      const result = await upsertBadge(
        ctx.db,
        input.repoId,
        repo.org.name,
        repo.name,
        input.changelistNumber,
        ctx.session.user.id,
        input as BadgeInput,
      );

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return result;
    }),

  // Post many badges at once (CI reporting a batch of steps/changes).
  postBatch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        badges: z
          .array(
            z.object({
              changelistNumber: z.number(),
              ...badgeFields.shape,
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .output(z.object({ count: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "teamSync", ctx.db);

      let count = 0;
      for (const badge of input.badges) {
        const exists = await ctx.db.changelist.findUnique({
          where: {
            repoId_number: {
              repoId: input.repoId,
              number: badge.changelistNumber,
            },
          },
          select: { number: true },
        });
        if (!exists) continue;

        await upsertBadge(
          ctx.db,
          input.repoId,
          repo.org.name,
          repo.name,
          badge.changelistNumber,
          ctx.session.user.id,
          badge as BadgeInput,
        );
        count++;
      }

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return { count };
    }),

  // Batch read for the changelist browser.
  getForChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumbers: z.array(z.number()).max(250),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const badges = await ctx.db.buildBadge.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: { in: input.changelistNumbers },
        },
        select: {
          changelistNumber: true,
          name: true,
          group: true,
          state: true,
          url: true,
          updatedAt: true,
        },
      });

      const result: Record<
        string,
        {
          name: string;
          group: string | null;
          state: (typeof badges)[number]["state"];
          url: string | null;
          updatedAt: Date;
        }[]
      > = {};
      for (const badge of badges) {
        (result[String(badge.changelistNumber)] ??= []).push({
          name: badge.name,
          group: badge.group,
          state: badge.state,
          url: badge.url,
          updatedAt: badge.updatedAt,
        });
      }
      return result;
    }),

  // Newest changelist at or before `startNumber` whose required badges are all
  // green (scheduled / manual "sync to latest good").
  findLatestGood: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        startNumber: z.number(),
        requiredBadges: z.array(z.string().min(1)).min(1),
        maxScan: z.number().int().min(1).max(2000).default(500),
      }),
    )
    .output(z.object({ changelistNumber: z.number() }).nullable())
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const changelistNumber = await findLatestGoodChangelist(
        ctx.db,
        input.repoId,
        input.startNumber,
        input.requiredBadges,
        input.maxScan,
      );

      return changelistNumber === null ? null : { changelistNumber };
    }),
});
