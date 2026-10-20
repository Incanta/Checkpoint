import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";

/** How long after approval a device can collect its token with the code. */
export const DEVICE_CODE_LIFETIME_MS = 10 * 60 * 1000;

export const apiTokenRouter = createTRPCRouter({
  getCode: publicProcedure.query(async ({ ctx }) => {
    const codeLength = 6;
    const codeDict = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    let code = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      code = "";

      for (let i = 0; i < codeLength; i++) {
        code += codeDict.charAt(crypto.randomInt(codeDict.length));
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
    .mutation(async ({ ctx, input }) => {
      // The pairing code is six characters and this route is unauthenticated,
      // so a code is only good for a short while after the token is approved
      // (the device is already polling by then), and only once.
      const notFound = new TRPCError({
        code: "NOT_FOUND",
        message: "API token not found for this device code",
      });
      const where = {
        deviceCode: input.code,
        createdAt: {
          gte: new Date(Date.now() - DEVICE_CODE_LIFETIME_MS),
        },
        OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
      };

      const apiToken = await ctx.db.apiToken.findFirst({ where });
      if (!apiToken) {
        throw notFound;
      }

      // Consume the code in the same statement that checks it is still
      // there, so two concurrent requests cannot both receive the token.
      const consumed = await ctx.db.apiToken.updateMany({
        where: { ...where, id: apiToken.id },
        data: { deviceCode: null },
      });
      if (consumed.count !== 1) {
        throw notFound;
      }

      return {
        apiToken: apiToken.token,
      };
    }),

  createApiToken: protectedProcedure
    .input(
      z.object({
        expiresAt: z.date().nullable(),
        name: z.string(),
        // Optional: when omitted/blank the token isn't tied to a device-pairing
        // code and is returned directly for the user to copy (headless/CI use).
        deviceCode: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const token = crypto.randomBytes(32).toString("hex");
      const deviceCode = input.deviceCode?.trim()
        ? input.deviceCode.trim()
        : null;

      await ctx.db.apiToken.create({
        data: {
          expiresAt: input.expiresAt,
          name: input.name,
          token,
          deviceCode,
          userId: ctx.session.user.id,
        },
      });

      // Only surface the raw token to the browser when it wasn't tied to a
      // device code. In the device-pairing flow the device retrieves the token
      // itself via getApiToken, so it is never shown in the web UI.
      return {
        apiToken: deviceCode ? null : token,
      };
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
