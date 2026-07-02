import crypto from "node:crypto";
import { z } from "zod";
import {
  createTRPCRouter,
  publicProcedure,
  adminProcedure,
} from "~/server/api/trpc";

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

  acceptEula: adminProcedure
    .input(z.object({ telemetryEnabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.instanceSettings.findUnique({
        where: { id: "default" },
      });

      await ctx.db.instanceSettings.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          // Generate the globally-unique installation id the first time the
          // instance is configured. It is sent with anonymous telemetry.
          instanceId: crypto.randomUUID(),
          eulaAcceptedAt: new Date(),
          eulaAcceptedBy: ctx.session.user.id,
          telemetryEnabled: input.telemetryEnabled,
        },
        update: {
          eulaAcceptedAt: new Date(),
          eulaAcceptedBy: ctx.session.user.id,
          telemetryEnabled: input.telemetryEnabled,
          // Backfill instanceId if a settings row predated this field.
          ...(existing?.instanceId ? {} : { instanceId: crypto.randomUUID() }),
        },
      });

      return { success: true };
    }),
});
