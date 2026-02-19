import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { RepoAccess, type Prisma } from "@prisma/client";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";

export const fileRouter = createTRPCRouter({
  getFiles: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string()),
        repoId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

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
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

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
        repoId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      return ctx.db.fileCheckout.findMany({
        where: {
          workspaceId: input.workspaceId,
          removedAt: null,
        },
        include: {
          file: true,
        },
      });
    }),

  getActiveCheckoutsForFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        filePaths: z.array(z.string()),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const normalizedPaths = input.filePaths.map((p) =>
        p.replaceAll("\\", "/"),
      );

      type CheckoutWithRelations = Prisma.FileCheckoutGetPayload<{
        include: {
          file: true;
          workspace: {
            include: {
              user: {
                select: {
                  id: true;
                  email: true;
                  name: true;
                  username: true;
                };
              };
            };
          };
        };
      }>;

      const checkouts: CheckoutWithRelations[] =
        await ctx.db.fileCheckout.findMany({
          where: {
            repoId: input.repoId,
            removedAt: null,
            file: {
              path: { in: normalizedPaths },
            },
          },
          include: {
            file: true,
            workspace: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    name: true,
                    username: true,
                  },
                },
              },
            },
          },
        });

      return checkouts.map((c) => ({
        id: c.id,
        fileId: c.fileId,
        filePath: c.file.path,
        locked: c.locked,
        workspaceId: c.workspaceId,
        userId: c.workspace.userId,
        user: c.workspace.user,
      }));
    }),

  checkout: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        workspaceId: z.string(),
        filePath: z.string(),
        locked: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      const normalizedPath = input.filePath.replaceAll("\\", "/");

      // Find or create the file record
      let file = await ctx.db.file.findFirst({
        where: {
          repoId: input.repoId,
          path: normalizedPath,
        },
      });

      if (!file) {
        file = await ctx.db.file.create({
          data: {
            repoId: input.repoId,
            path: normalizedPath,
          },
        });
      }

      // Check if this user already has an active checkout for this file
      const existingCheckout = await ctx.db.fileCheckout.findFirst({
        where: {
          fileId: file.id,
          workspaceId: input.workspaceId,
          removedAt: null,
        },
      });

      if (existingCheckout) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have an active checkout for this file",
        });
      }

      // If requesting a lock, check that no other active checkout has locked=true
      if (input.locked) {
        const existingLock = await ctx.db.fileCheckout.findFirst({
          where: {
            fileId: file.id,
            removedAt: null,
            locked: true,
          },
        });

        if (existingLock) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This file is already locked by another user",
          });
        }
      }

      const checkout = await ctx.db.fileCheckout.create({
        data: {
          fileId: file.id,
          repoId: input.repoId,
          workspaceId: input.workspaceId,
          locked: input.locked,
        },
      });

      return checkout;
    }),

  undoCheckout: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        workspaceId: z.string(),
        filePath: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      const normalizedPath = input.filePath.replaceAll("\\", "/");

      const file = await ctx.db.file.findFirst({
        where: {
          repoId: input.repoId,
          path: normalizedPath,
        },
      });

      if (!file) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      const checkout = await ctx.db.fileCheckout.findFirst({
        where: {
          fileId: file.id,
          workspaceId: input.workspaceId,
          removedAt: null,
        },
      });

      if (!checkout) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No active checkout found for this file",
        });
      }

      await ctx.db.fileCheckout.update({
        where: { id: checkout.id },
        data: { removedAt: new Date() },
      });

      return { success: true };
    }),

  getFileHistory: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        filePath: z.string(),
        count: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

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
