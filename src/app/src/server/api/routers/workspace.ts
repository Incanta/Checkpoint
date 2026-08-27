import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";
import { RepoAccess } from "@prisma/client";

export const workspaceRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.workspace.findMany({
      where: {
        deletedAt: null,
        userId: ctx.session.user.id,
      },
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        repoId: z.string(),
        defaultBranchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      const newWorkspace = await ctx.db.workspace.create({
        data: {
          name: input.name,
          userId: ctx.session.user.id,
          repoId: input.repoId,
          orgId: repo.orgId,
        },
      });

      return newWorkspace;
    }),

  // Game Sync presence: the daemon reports the CL a workspace synced to after
  // each successful pull so other clients can show "N users synced here".
  updateSyncStatus: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        changelistNumber: z.number().nullable(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      await ctx.db.workspace.update({
        where: { id: input.workspaceId },
        data: {
          syncedChangelistNumber: input.changelistNumber,
          syncedAt: new Date(),
        },
      });

      return { ok: true as const };
    }),
});
