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
