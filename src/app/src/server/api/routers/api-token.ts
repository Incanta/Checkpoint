import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";

export const apiTokenRouter = createTRPCRouter({
  getCode: publicProcedure.query(async ({ ctx }) => {
    const codeLength = 6;
    const codeDict = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    let code = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      code = "";

      for (let i = 0; i < codeLength; i++) {
        code += codeDict.charAt(Math.floor(Math.random() * codeDict.length));
      }

      const numTokens = await ctx.db.apiToken.count({
        where: {
          deviceCode: code,
        },
      });

      if (numTokens === 0) {
        break;
      }
    }

    return {
      code,
    };
  }),

  getApiToken: publicProcedure
    .input(
      z.object({
        code: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const apiToken = await ctx.db.apiToken.findUnique({
        where: {
          deviceCode: input.code,
          OR: [
            {
              expiresAt: null,
            },
            {
              expiresAt: {
                gte: new Date(),
              },
            },
          ],
        },
      });

      if (!apiToken) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API token not found for this device code",
        });
      }

      await ctx.db.apiToken.update({
        where: {
          id: apiToken.id,
        },
        data: {
          deviceCode: null, // one time use code
        },
      });

      return {
        apiToken: apiToken.token,
      };
    }),

  createApiToken: protectedProcedure
    .input(
      z.object({
        expiresAt: z.date().nullable(),
        name: z.string(),
        deviceCode: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const token = crypto.randomBytes(32).toString("hex");

      await ctx.db.apiToken.create({
        data: {
          expiresAt: input.expiresAt,
          name: input.name,
          token,
          deviceCode: input.deviceCode,
          userId: ctx.session.user.id,
        },
      });
    }),

  getActiveDevices: protectedProcedure.query(async ({ ctx }) => {
    const activeDevices = await ctx.db.apiToken.findMany({
      where: {
        userId: ctx.session.user.id,
        OR: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              gte: new Date(),
            },
          },
        ],
      },
    });

    return {
      activeDevices: activeDevices.map((device) => {
        // these should not be returned
        device.deviceCode = null;
        device.token = "";

        return device;
      }),
    };
  }),

  revokeDevice: protectedProcedure
    .input(
      z.object({
        deviceId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.apiToken.update({
        where: {
          userId: ctx.session.user.id,
          id: input.deviceId,
        },
        data: {
          expiresAt: new Date(),
        },
      });
    }),
});
