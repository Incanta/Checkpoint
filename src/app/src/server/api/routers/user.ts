import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx }) => {
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

    return checkpointUser;
  }),

  createUser: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        username: z.string().min(1),
        email: z.string().email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Only allow in test environments for now
      if (process.env.NODE_ENV !== "test") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "createUser is only available in testing environments",
        });
      }

      return ctx.db.user.create({
        data: input,
      });
    }),

  updateUser: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        username: z.string().optional(),
        email: z.string().email().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...updateData } = input;

      return ctx.db.user.update({
        where: { id },
        data: updateData,
      });
    }),
});
