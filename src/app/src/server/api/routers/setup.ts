import { createTRPCRouter, publicProcedure, adminProcedure } from "~/server/api/trpc";

export const setupRouter = createTRPCRouter({
  getStatus: publicProcedure.query(async ({ ctx }) => {
    const [userCount, settings] = await Promise.all([
      ctx.db.user.count(),
      ctx.db.instanceSettings.findUnique({ where: { id: "default" } }),
    ]);

    return {
      hasUsers: userCount > 0,
      eulaAccepted: !!settings?.eulaAcceptedAt,
      registrationOpen: userCount === 0 || !!settings?.eulaAcceptedAt,
    };
  }),

  acceptEula: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.db.instanceSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        eulaAcceptedAt: new Date(),
        eulaAcceptedBy: ctx.session.user.id,
      },
      update: {
        eulaAcceptedAt: new Date(),
        eulaAcceptedBy: ctx.session.user.id,
      },
    });

    return { success: true };
  }),
});
