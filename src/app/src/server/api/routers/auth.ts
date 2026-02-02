import config from "@incanta/config";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

export const authRouter = createTRPCRouter({
  checkUsername: publicProcedure
    .input(
      z.object({
        username: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const existingUser = await ctx.db.user.findFirst({
        where: { username: input.username },
        select: { id: true },
      });

      return {
        available: !existingUser,
      };
    }),

  checkEmail: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const existingUser = await ctx.db.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });

      return {
        available: !existingUser,
      };
    }),

  /**
   * Development-only endpoint to create an API token for automated testing.
   * This bypasses OAuth flow and allows creating a session directly.
   *
   * WARNING: This should NEVER be enabled in production!
   */
  devLogin: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        deviceCode: z.string().optional(),
        tokenName: z.string().default("dev-test-token"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const allowDevLogin = config.get<boolean>("auth.dev.allow-dev-login");

      if (!allowDevLogin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Development login is not enabled. Set auth.dev.allow-dev-login to true in config.",
        });
      }

      // Find or create the user
      let user = await ctx.db.user.findUnique({
        where: { email: input.email },
      });

      if (!user) {
        // Create a new user for testing
        user = await ctx.db.user.create({
          data: {
            email: input.email,
            name: input.email.split("@")[0],
            username: input.email.split("@")[0]?.replace(/[^a-zA-Z0-9]/g, "_"),
          },
        });
      }

      // Generate a new API token
      const token = crypto.randomBytes(32).toString("hex");

      const apiToken = await ctx.db.apiToken.create({
        data: {
          name: input.tokenName,
          token,
          deviceCode: input.deviceCode ?? null,
          userId: user.id,
          expiresAt: null, // Never expires for dev tokens
        },
      });

      return {
        apiToken: apiToken.token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          username: user.username,
        },
      };
    }),
});
