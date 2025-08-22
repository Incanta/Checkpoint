import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  createTRPCRouter,
  protectedProcedure,
} from "~/server/api/trpc";

export const changelistRouter = createTRPCRouter({
  getChangelist: protectedProcedure
    .input(z.object({
      id: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { email: ctx.session.user.email! },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user"
        });
      }

      // Check repo access (similar to other routers)
      // ... access check logic ...

      return ctx.db.changelist.findUnique({
        where: {
          id: input.id,
        },
      });
    }),

  getChangelists: protectedProcedure
    .input(z.object({
      repoId: z.string(),
      numbers: z.array(z.number()),
    }))
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { email: ctx.session.user.email! },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user"
        });
      }

      // Check repo access (similar to other routers)
      // ... access check logic ...

      return ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: {
            in: input.numbers,
          },
        },
      });
    }),

  createChangelist: protectedProcedure
    .input(z.object({
      message: z.string(),
      repoId: z.string(),
      versionIndex: z.string(),
      branchName: z.string(),
      modifications: z.array(z.object({
        delete: z.boolean(),
        path: z.string(),
        oldPath: z.string().optional(),
      })),
      keepCheckedOut: z.boolean(),
      workspaceId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { email: ctx.session.user.email! },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user"
        });
      }

      // Check write permissions to repo
      // ... permission check logic ...

      // Get the next changelist number
      const lastChangelist = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });

      const nextNumber = (lastChangelist?.number ?? -1) + 1;

      // Create the changelist
      const changelist = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: input.message,
          versionIndex: input.versionIndex,
          stateTree: {}, // TODO: implement state tree logic
          repoId: input.repoId,
          userId: checkpointUser.id,
        },
      });

      // Update branch head if needed
      const branch = await ctx.db.branch.findFirst({
        where: {
          repoId: input.repoId,
          name: input.branchName,
        },
      });

      if (branch) {
        await ctx.db.branch.update({
          where: { id: branch.id },
          data: { headNumber: nextNumber },
        });
      }

      // TODO: Handle file changes and workspace checkout logic
      // For now, just return the basic changelist info

      return {
        id: changelist.id,
        number: changelist.number,
      };
    }),
});
