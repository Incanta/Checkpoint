import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const storageRouter = createTRPCRouter({
  getToken: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        write: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
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

      // Check if user has access to this repo
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: {
          org: {
            include: {
              users: {
                where: { userId: checkpointUser.id },
              },
            },
          },
          additionalRoles: {
            where: { userId: checkpointUser.id },
          },
        },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      // Check permissions
      const orgUser = repo.org.users[0];
      const repoRole = repo.additionalRoles[0];

      const hasAccess =
        repo.public ||
        !!orgUser ||
        repo.org.defaultRepoAccess !== "NONE" ||
        (repoRole && repoRole.access !== "NONE");

      if (!hasAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this repository",
        });
      }

      // Check write permissions if needed
      if (input.write) {
        const hasWriteAccess =
          orgUser?.role === "ADMIN" ||
          repo.org.defaultRepoAccess === "WRITE" ||
          repo.org.defaultRepoAccess === "ADMIN" ||
          repoRole?.access === "WRITE" ||
          repoRole?.access === "ADMIN";

        if (!hasWriteAccess) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have write access to this repository",
          });
        }
      }

      // TODO: Generate actual storage token from SeaweedFS or configured storage backend
      // For now, return a mock response
      return {
        token: "mock-storage-token",
        expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        backendUrl: process.env.STORAGE_BACKEND_URL ?? "http://localhost:8080",
      };
    }),
});
