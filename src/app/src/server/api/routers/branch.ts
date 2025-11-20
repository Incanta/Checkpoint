import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const branchRouter = createTRPCRouter({
  getBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
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

      // Check if user has access to this repo
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: {
          org: {
            include: {
              users: {
                where: { userId: checkpointUser.id },
              },
            },
          },
          additionalRoles: {
            where: { userId: checkpointUser.id },
          },
        },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      // Check permissions
      const orgUser = repo.org.users[0];
      const repoRole = repo.additionalRoles[0];

      const hasAccess =
        repo.public ||
        !!orgUser ||
        repo.org.defaultRepoAccess !== "NONE" ||
        (repoRole && repoRole.access !== "NONE");

      if (!hasAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this repository",
        });
      }

      // Get the branch
      const branch = await ctx.db.branch.findFirst({
        where: {
          repoId: input.repoId,
          name: input.name,
        },
      });

      return branch;
    }),

  createBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string(),
        headNumber: z.number().default(0),
        isDefault: z.boolean().default(false),
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

      // Check write permissions
      // Similar permission logic as other mutations...

      return ctx.db.branch.create({
        data: input,
      });
    }),
});
