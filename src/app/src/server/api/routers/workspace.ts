import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const workspaceRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    // Find the Checkpoint user associated with this NextAuth user
    const checkpointUser = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
    });

    if (!checkpointUser) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Checkpoint user not found for this authenticated user",
      });
    }

    return ctx.db.workspace.findMany({
      where: {
        deletedAt: null,
        userId: checkpointUser.id,
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
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      // TODO check auth

      const newWorkspace = await ctx.db.workspace.create({
        data: {
          name: input.name,
          userId: checkpointUser.id,
          repoId: input.repoId,
          orgId: repo.orgId,
        },
      });

      return newWorkspace;
    }),
});
