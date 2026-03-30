import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const emailRouter = createTRPCRouter({
  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    let prefs = await ctx.db.emailPreferences.findUnique({
      where: { userId },
    });

    // Auto-create with defaults on first access
    if (!prefs) {
      prefs = await ctx.db.emailPreferences.create({
        data: { userId },
      });
    }

    return prefs;
  }),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        accountSecurity: z.boolean().optional(),
        orgActivity: z.boolean().optional(),
        repoActivity: z.boolean().optional(),
        mentions: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      return ctx.db.emailPreferences.upsert({
        where: { userId },
        create: { userId, ...input },
        update: input,
      });
    }),
});
