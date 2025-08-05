import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { computePasswordHash } from "~/server/auth/credentials";
import { randomBytes } from "crypto";

export const authRouter = createTRPCRouter({
  register: publicProcedure
    .input(z.object({
      username: z.string().min(1, "Username is required").max(50, "Username too long"),
      email: z.string().email("Invalid email format"),
      password: z.string().min(8, "Password must be at least 8 characters"),
      name: z.string().min(1, "Name is required").max(100, "Name too long"),
    }))
    .mutation(async ({ ctx, input }) => {
      // Check if username already exists
      const existingUser = await ctx.db.user.findFirst({
        where: {
          OR: [
            { username: input.username },
            { email: input.email },
          ],
        },
      });

      if (existingUser) {
        throw new TRPCError({
          code: "CONFLICT",
          message: existingUser.username === input.username
            ? "Username already exists"
            : "Email already exists",
        });
      }

      // Generate a globally unique salt
      const salt = randomBytes(32).toString("hex");

      // Hash the password with the salt
      const hash = await computePasswordHash(input.password, salt);

      const numUsers = await ctx.db.user.count();

      // Create the user
      const user = await ctx.db.user.create({
        data: {
          username: input.username,
          email: input.email,
          name: input.name,
          salt,
          hash,
          checkpointAdmin: numUsers === 0,
        },
        select: {
          id: true,
          username: true,
          email: true,
          name: true,
          checkpointAdmin: true,
        },
      });

      // Create Account record for credentials provider to enable database sessions
      await ctx.db.account.create({
        data: {
          userId: user.id,
          type: "credentials",
          provider: "credentials",
          providerAccountId: user.id,
        },
      });

      return {
        success: true,
        user,
        message: "User registered successfully",
      };
    }),

  checkUsername: publicProcedure
    .input(z.object({
      username: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      const existingUser = await ctx.db.user.findUnique({
        where: { username: input.username },
        select: { id: true },
      });

      return {
        available: !existingUser,
      };
    }),

  checkEmail: publicProcedure
    .input(z.object({
      email: z.string().email(),
    }))
    .query(async ({ ctx, input }) => {
      const existingUser = await ctx.db.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });

      return {
        available: !existingUser,
      };
    }),
});
