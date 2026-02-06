import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const fileRouter = createTRPCRouter({
  getFiles: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string()),
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

      // Check repo access (similar to other routers)
      // ... access check logic ...

      return ctx.db.file.findMany({
        where: {
          id: {
            in: input.ids,
          },
        },
      });
    }),

  getFileIds: protectedProcedure
    .input(
      z.object({
        paths: z.array(z.string()),
        repoId: z.string(),
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

      // Check repo access (similar to other routers)
      // ... access check logic ...

      const files = await ctx.db.file.findMany({
        where: {
          repoId: input.repoId,
          path: {
            in: input.paths.map((p) => p.replaceAll("\\", "/")),
          },
        },
      });

      return files.map((file) => ({
        id: file.id,
        path: file.path,
      }));
    }),

  getCheckouts: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
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

      // Check repo access (similar to other routers)
      // ... access check logic ...

      return ctx.db.fileCheckout.findMany({
        where: {
          workspaceId: input.workspaceId,
        },
        include: {
          file: true,
        },
      });
    }),

  getFileHistory: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        filePath: z.string(),
        count: z.number().min(1).max(100).default(50),
      }),
    )
    .output(
      z.array(
        z.object({
          changelistNumber: z.number(),
          changeType: z.enum(["ADD", "DELETE", "MODIFY"]),
          oldPath: z.string().nullable(),
          changelist: z.object({
            id: z.string(),
            number: z.number(),
            message: z.string().nullable(),
            createdAt: z.date(),
            updatedAt: z.date(),
            userId: z.string().nullable(),
            user: z
              .object({
                email: z.string().nullable(),
                name: z.string().nullable(),
                username: z.string().nullable(),
              })
              .nullable(),
          }),
        }),
      ),
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

      // Normalize the file path
      const normalizedPath = input.filePath.replaceAll("\\", "/");
      console.log("Getting file history for:", normalizedPath);

      // Find the file by path
      const file = await ctx.db.file.findFirst({
        where: {
          repoId: input.repoId,
          path: normalizedPath,
        },
      });

      if (!file) {
        return [];
      }

      // Get all file changes for this file, ordered by changelist number descending
      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          fileId: file.id,
          repoId: input.repoId,
        },
        include: {
          changelist: {
            include: {
              user: {
                select: {
                  email: true,
                  name: true,
                  username: true,
                },
              },
            },
          },
        },
        orderBy: {
          changelistNumber: "desc",
        },
        take: input.count,
      });

      return fileChanges.map((fc) => ({
        changelistNumber: fc.changelistNumber,
        changeType: fc.type,
        oldPath: fc.oldPath,
        changelist: {
          id: fc.changelist.id,
          number: fc.changelist.number,
          message: fc.changelist.message,
          createdAt: fc.changelist.createdAt,
          updatedAt: fc.changelist.updatedAt,
          userId: fc.changelist.userId,
          user: fc.changelist.user,
        },
      }));
    }),
});
