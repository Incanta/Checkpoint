import { z } from "zod";
import { TRPCError } from "@trpc/server";
import config from "@incanta/config";
import njwt from "njwt";
import {
  readFileFromVersionAsync,
  pollReadFileHandle,
  freeReadFileHandle,
  GetLogLevel,
} from "@checkpointvcs/longtail-addon";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { RepoAccess, type Prisma } from "@prisma/client";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";
import { recordActivity } from "../activity";
import {
  resolveBinaryExtensions,
  isBinaryFile,
} from "~/server/binary-extensions";
import { Logger } from "~/server/logging";

const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5 MB text limit

export const fileRouter = createTRPCRouter({
  getFiles: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string()),
        repoId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
    .mutation(async ({ ctx, input }) => {
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
    .mutation(async ({ ctx, input }) => {
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

  // TODO MIKE HERE: should we have a checkoutMany?
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
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
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
        if (input.locked && !existingCheckout.locked) {
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

          await ctx.db.fileCheckout.update({
            where: { id: existingCheckout.id },
            data: { locked: true },
          });

          // Record write activity for billing (fire-and-forget)
          void recordActivity(ctx.db, {
            userId: ctx.session.user.id,
            orgId: repo.orgId,
            type: "write",
          });

          return {
            ...existingCheckout,
            locked: true,
          };
        }

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

      // Record write activity for billing (fire-and-forget)
      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
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

  getRepoCheckouts: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        lockedOnly: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const where: Prisma.FileCheckoutWhereInput = {
        repoId: input.repoId,
        removedAt: null,
        ...(input.lockedOnly && { locked: true }),
      };

      const checkouts = await ctx.db.fileCheckout.findMany({
        where,
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
        orderBy: { createdAt: "desc" },
      });

      return checkouts.map((c) => ({
        id: c.id,
        fileId: c.fileId,
        filePath: c.file.path,
        locked: c.locked,
        createdAt: c.createdAt,
        workspaceId: c.workspaceId,
        workspaceName: c.workspace.name,
        userId: c.workspace.userId,
        user: c.workspace.user,
      }));
    }),

  adminUnlockFile: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        checkoutId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.ADMIN);

      const checkout = await ctx.db.fileCheckout.findFirst({
        where: {
          id: input.checkoutId,
          repoId: input.repoId,
          removedAt: null,
          locked: true,
        },
      });

      if (!checkout) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No active locked checkout found",
        });
      }

      await ctx.db.fileCheckout.update({
        where: { id: checkout.id },
        data: { locked: false },
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

  listFolder: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        folderPath: z.string().default(""),
        includeArtifacts: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const changelist = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.changelistNumber,
          },
        },
        select: { stateTree: true, artifactStateTree: true },
      });

      if (!changelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Changelist not found",
        });
      }

      const stateTree = changelist.stateTree as Record<string, number>;
      const artifactStateTree = input.includeArtifacts
        ? ((changelist.artifactStateTree as Record<string, number> | null) ??
          {})
        : {};
      const aliveFileIds = new Set([
        ...Object.keys(stateTree),
        ...Object.keys(artifactStateTree),
      ]);
      const artifactFileIds = new Set(Object.keys(artifactStateTree));

      // Get all files for this repo (only id + path for efficiency)
      const allFiles = await ctx.db.file.findMany({
        where: { repoId: input.repoId },
        select: { id: true, path: true },
      });

      // Normalize folderPath: ensure it ends with "/" if non-empty
      const prefix =
        input.folderPath === ""
          ? ""
          : input.folderPath.endsWith("/")
            ? input.folderPath
            : input.folderPath + "/";

      const folders = new Set<string>();
      const files: {
        name: string;
        path: string;
        lastCl: number;
        isArtifact: boolean;
      }[] = [];
      let totalFileCount = 0;

      for (const file of allFiles) {
        if (!aliveFileIds.has(file.id)) continue;
        totalFileCount++;

        // Check if this file is under the requested folder
        if (!file.path.startsWith(prefix)) continue;

        const remainder = file.path.slice(prefix.length);
        const slashIndex = remainder.indexOf("/");

        if (slashIndex === -1) {
          // Direct child file
          const lastCl = stateTree[file.id] ?? artifactStateTree[file.id]!;
          files.push({
            name: remainder,
            path: file.path,
            lastCl,
            isArtifact: artifactFileIds.has(file.id),
          });
        } else {
          // Subfolder — collect unique folder name
          folders.add(remainder.slice(0, slashIndex));
        }
      }

      return {
        folders: [...folders].sort((a, b) => a.localeCompare(b)),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
        totalFileCount,
      };
    }),

  readFileContent: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        filePath: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      // find the most recent FileChange prior to the requested CL for this file to get the file ID
      const fileChange = await ctx.db.fileChange.findFirst({
        where: {
          repoId: input.repoId,
          changelistNumber: {
            lte: input.changelistNumber,
          },
          file: {
            path: input.filePath,
          },
        },
        orderBy: {
          changelistNumber: "desc",
        },
        include: {
          changelist: true,
        },
      });

      if (!fileChange) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found in changelist history",
        });
      }

      if (!fileChange.changelist?.versionIndex) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Changelist or version index not found",
        });
      }

      const binaryExts = resolveBinaryExtensions(repo.org.binaryExtensions);
      const binary = isBinaryFile(input.filePath, binaryExts);

      // For binary files, return metadata only (no content)
      if (binary) {
        return { content: null, isBinary: true, size: 0 };
      }

      const remoteBasePath = `/${repo.orgId}/${repo.id}`;

      const readToken = njwt.create(
        {
          iss: "checkpoint-vcs",
          sub: ctx.session.user.id,
          userId: ctx.session.user.id,
          orgId: repo.orgId,
          repoId: repo.id,
          mode: "read",
          basePath: remoteBasePath,
        },
        config.get<string>("storage.jwt.signing-key"),
      );

      const expirationSeconds = config.get<number>(
        "storage.token-expiration-seconds",
      );
      readToken.setExpiration(Date.now() + expirationSeconds * 1000);
      const jwt = readToken.compact();
      const jwtExpirationMs = Date.now() + expirationSeconds * 1000;

      const backendUrl = config.get<string>("storage.backend-url.internal");
      const filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) =>
        res.text(),
      );

      const logLevel = GetLogLevel(
        config.get<string>(
          "logging.longtail-level",
        ) as import("@checkpointvcs/longtail-addon").LongtailLogLevel,
      );

      const handle = readFileFromVersionAsync({
        filePath: input.filePath,
        versionIndexName: fileChange.changelist.versionIndex,
        remoteBasePath,
        filerUrl,
        jwt,
        jwtExpirationMs,
        logLevel,
      });

      if (!handle) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to initiate file read",
        });
      }

      try {
        const { data, size } = await pollReadFileHandle(handle);

        if (!data || size === 0) {
          return { content: "", isBinary: false, size: 0 };
        }

        if (size > MAX_TEXT_SIZE) {
          return {
            content: null,
            isBinary: false,
            size,
            tooLarge: true,
          };
        }

        return {
          content: data.toString("utf-8"),
          isBinary: false,
          size,
        };
      } finally {
        freeReadFileHandle(handle);
      }
    }),
});
