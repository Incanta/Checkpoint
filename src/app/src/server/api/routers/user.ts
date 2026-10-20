import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getCheckpointUser } from "../auth-utils";
import { isLicenseManager } from "~/server/license-utils";

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx }) => {
    const checkpointUser = await getCheckpointUser(ctx);

    return { ...checkpointUser, isLicenseManager: isLicenseManager() };
  }),

  updateUser: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        username: z.string().optional(),
        email: z.string().email().optional(),
        image: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...updateData } = input;

      // Only your own profile. The id is still accepted so existing clients
      // keep working, but it has to be yours: with any id, anyone could
      // change another user's email and take the account over.
      if (id !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only update your own profile",
        });
      }

      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: updateData,
      });
    }),
});
