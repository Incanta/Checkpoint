import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { FileChangeType, RepoAccess, type Changelist } from "@prisma/client";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";
import { recordActivity } from "../activity";
import type { InputJsonValue } from "@prisma/client/runtime/library";

export const changelistRouter = createTRPCRouter({
  getChangelist: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      return ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.changelistNumber,
          },
        },
      });
    }),

  getChangelistsWithNumbers: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        numbers: z.array(z.number()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      return await ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: {
            in: input.numbers,
          },
        },
      });
    }),

  getChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        branchName: z.string(),
        start: z.object({
          number: z.number().nullable(),
          timestamp: z.date().nullable(),
        }),
        count: z.number().min(1).max(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      let startNumber: number | Date | null = null;

      if (input.start.number === null && input.start.timestamp === null) {
        // our starting place is the headNumber for the branch
        const branch = await ctx.db.branch.findUnique({
          where: {
            repoId_name: {
              repoId: input.repoId,
              name: input.branchName,
            },
          },
        });

        if (!branch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Could not find branch ${input.branchName} in the repo`,
          });
        }

        startNumber = branch.headNumber;
      } else if (
        input.start.number !== null &&
        input.start.timestamp === null
      ) {
        startNumber = input.start.number;
      } else {
        startNumber = input.start.timestamp;
      }

      if (startNumber === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No valid start number found to retrieve changelists",
        });
      }

      let startChangelist:
        | (Changelist & { user: { email: string } | null })
        | null = null;
      if (typeof startNumber === "object") {
        // must be a date; find the first changelist less than this date
        startChangelist = await ctx.db.changelist.findFirst({
          where: {
            repoId: input.repoId,
            createdAt: {
              lte: startNumber,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          include: {
            user: {
              select: {
                email: true,
              },
            },
          },
        });
      } else {
        startChangelist = await ctx.db.changelist.findUnique({
          where: {
            repoId_number: {
              repoId: input.repoId,
              number: startNumber,
            },
          },
          include: {
            user: {
              select: {
                email: true,
              },
            },
          },
        });
      }

      if (!startChangelist) {
        // this probably shouldn't happen
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Could not find a start number to retrieve changelists from",
        });
      }

      // TODO MIKE HERE now we need to find the recursive parents; let's be dumb about it for now
      const changelists = [startChangelist];
      while (changelists.length < input.count) {
        const lastChangelist = changelists.at(-1)!;

        if (lastChangelist.parentNumber === null) {
          break;
        }

        const parentChangelist = await ctx.db.changelist.findUnique({
          where: {
            repoId_number: {
              repoId: input.repoId,
              number: lastChangelist.parentNumber,
            },
          },
          include: {
            user: {
              select: {
                email: true,
              },
            },
          },
        });

        if (!parentChangelist) {
          // TODO MIKE HERE: should log this invalid parent number
          break;
        }

        changelists.push(parentChangelist);
      }

      return changelists;
    }),

  getChangelistFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: input.changelistNumber,
        },
        include: {
          file: {
            select: {
              id: true,
              path: true,
            },
          },
        },
        orderBy: {
          file: {
            path: "asc",
          },
        },
      });

      return fileChanges.map((fc) => ({
        id: fc.id,
        fileId: fc.file.id,
        path: fc.file.path,
        changeType: fc.type,
        oldPath: fc.oldPath,
      }));
    }),

  createChangelist: protectedProcedure
    .input(
      z.object({
        message: z.string(),
        repoId: z.string(),
        versionIndex: z.string(),
        branchName: z.string(),
        modifications: z.array(
          z.object({
            delete: z.boolean(),
            path: z.string(),
            oldPath: z.string().optional(),
          }),
        ),
        keepCheckedOut: z.boolean(),
        workspaceId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      // Check for locked files by other users
      const normalizedPaths = input.modifications.map((mod) =>
        mod.path.replaceAll("\\", "/"),
      );

      const BATCH_SIZE = 20000;

      const lockedCheckouts: any[] = [];
      for (let i = 0; i < normalizedPaths.length; i += BATCH_SIZE) {
        const batch = normalizedPaths.slice(i, i + BATCH_SIZE);
        const results = await ctx.db.fileCheckout.findMany({
          where: {
            repoId: input.repoId,
            removedAt: null,
            locked: true,
            file: {
              path: { in: batch },
            },
            workspace: {
              userId: { not: ctx.session.user.id },
            },
          },
          include: {
            file: true,
            workspace: {
              include: {
                user: {
                  select: { email: true, name: true, username: true },
                },
              },
            },
          },
        });
        for (const r of results) lockedCheckouts.push(r);
      }

      if (lockedCheckouts.length > 0) {
        const lockedFiles = lockedCheckouts.map((c) => {
          const displayName =
            c.workspace.user.name ||
            c.workspace.user.username ||
            c.workspace.user.email;
          return `${c.file.path} (locked by ${displayName})`;
        });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Cannot submit: the following files are locked by other users:\n${lockedFiles.join("\n")}`,
        });
      }

      // Get the next changelist number
      const lastChangelist = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });

      const nextNumber = (lastChangelist?.number ?? -1) + 1;

      const branch = await ctx.db.branch.findFirst({
        where: {
          repoId: input.repoId,
          name: input.branchName,
        },
      });

      if (!branch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch ${input.branchName} not found in the repo`,
        });
      }

      if (branch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Branch ${input.branchName} is archived and read-only`,
        });
      }

      const parentChangelist = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: branch.headNumber,
          },
        },
      });

      if (!parentChangelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Parent changelist ${branch.headNumber} not found in the repo`,
        });
      }

      const stateTree: Record<string, number> =
        parentChangelist.stateTree as Record<string, number>;

      // Apply modifications to state tree
      // Batch queries in chunks to avoid exceeding DB parameter limits
      const allPaths = input.modifications.map((mod) =>
        mod.path.replaceAll("\\", "/"),
      );

      const modifiedFiles: Awaited<ReturnType<typeof ctx.db.file.findMany>> =
        [];
      for (let i = 0; i < allPaths.length; i += BATCH_SIZE) {
        const batch = allPaths.slice(i, i + BATCH_SIZE);
        const results = await ctx.db.file.findMany({
          where: {
            repoId: input.repoId,
            path: { in: batch },
          },
        });
        for (const r of results) modifiedFiles.push(r);
      }

      // Batch-create any new file entries that don't already exist
      const existingPathSet = new Set(modifiedFiles.map((f) => f.path));
      const newFilePaths = input.modifications
        .filter((mod) => !mod.delete)
        .map((mod) => mod.path.replaceAll("\\", "/"))
        .filter((p) => !existingPathSet.has(p));

      if (newFilePaths.length > 0) {
        for (let i = 0; i < newFilePaths.length; i += BATCH_SIZE) {
          const batch = newFilePaths.slice(i, i + BATCH_SIZE);
          await ctx.db.file.createMany({
            data: batch.map((path) => ({
              repoId: input.repoId,
              path,
            })),
          });
        }

        // Re-fetch to get the newly created file records with their IDs
        for (let i = 0; i < newFilePaths.length; i += BATCH_SIZE) {
          const batch = newFilePaths.slice(i, i + BATCH_SIZE);
          const newFiles = await ctx.db.file.findMany({
            where: {
              repoId: input.repoId,
              path: { in: batch },
            },
          });
          for (const f of newFiles) modifiedFiles.push(f);
        }
      }

      // Build a path→file map for O(1) lookups instead of O(n) find()
      const filesByPath = new Map(modifiedFiles.map((f) => [f.path, f]));
      const fileIdsForPaths: Record<string, string | undefined> = {};
      for (const mod of input.modifications) {
        const modPath = mod.path.replaceAll("\\", "/");
        const existingFile = filesByPath.get(modPath);

        fileIdsForPaths[mod.path] = existingFile?.id;

        if (mod.delete) {
          if (existingFile) {
            delete stateTree[existingFile.id];
          }
        } else {
          stateTree[existingFile!.id] = nextNumber;
        }
      }

      // Create the changelist (inherit artifact state from parent)
      const changelist = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: input.message,
          versionIndex: input.versionIndex,
          parentNumber: branch.headNumber,
          stateTree: stateTree,
          artifactVersionIndex: parentChangelist.artifactVersionIndex,
          artifactStateTree:
            parentChangelist.artifactStateTree as InputJsonValue,
          repoId: input.repoId,
          userId: ctx.session.user.id,
        },
      });

      await ctx.db.branch.update({
        where: { id: branch.id },
        data: { headNumber: nextNumber },
      });

      await ctx.db.fileChange.createMany({
        data: input.modifications
          .filter((mod) => fileIdsForPaths[mod.path])
          .map((mod) => {
            return {
              repoId: input.repoId,
              fileId: fileIdsForPaths[mod.path]!,
              changelistNumber: nextNumber,
              type: mod.delete ? FileChangeType.DELETE : FileChangeType.MODIFY,
              oldPath: mod.oldPath ? mod.oldPath.replaceAll("\\", "/") : null,
            };
          }),
      });

      if (!input.keepCheckedOut) {
        await ctx.db.fileCheckout.updateMany({
          where: {
            workspaceId: input.workspaceId,
            fileId: {
              in: Object.values(fileIdsForPaths)
                .filter((id) => !!id)
                .map((id) => id!),
            },
          },
          data: {
            removedAt: new Date(),
          },
        });
      }

      // Record write activity for billing (fire-and-forget)
      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return {
        id: changelist.id,
        number: changelist.number,
      };
    }),

  getFilePathsChangedBetween: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        /** The older CL number (exclusive — changes IN this CL are NOT included). */
        fromNumber: z.number(),
        /** The newer CL number (inclusive — we start here and walk back). */
        toNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      // Walk the parent chain from toNumber back to (but not including) fromNumber
      // and collect all distinct file paths that were changed.
      const clNumbers: number[] = [];
      let currentNumber: number | null = input.toNumber;

      while (currentNumber !== null && currentNumber !== input.fromNumber) {
        clNumbers.push(currentNumber);

        const cl: { parentNumber: number | null } | null =
          await ctx.db.changelist.findUnique({
            where: {
              repoId_number: {
                repoId: input.repoId,
                number: currentNumber,
              },
            },
            select: { parentNumber: true },
          });

        if (!cl) break;
        currentNumber = cl.parentNumber;
      }

      if (clNumbers.length === 0) {
        return { paths: [] };
      }

      // Single query to get all file changes across the collected CLs
      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: { in: clNumbers },
        },
        include: {
          file: {
            select: { path: true },
          },
        },
      });

      // De-duplicate paths
      const paths = [...new Set(fileChanges.map((fc) => fc.file.path))];

      return { paths };
    }),
});
