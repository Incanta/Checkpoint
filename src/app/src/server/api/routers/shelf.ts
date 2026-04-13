// @obfuscate

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import config from "@incanta/config";
import njwt from "njwt";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { FileChangeType, Prisma, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import { assertFeature } from "~/server/license-client";
import {
  readFileFromVersionAsync,
  pollReadFileHandle,
  freeReadFileHandle,
  GetLogLevel,
} from "@checkpointvcs/longtail-addon";

const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5MB

function isBinaryFile(filePath: string): boolean {
  const binaryExtensions = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".webp",
    ".svg",
    ".mp3",
    ".wav",
    ".ogg",
    ".mp4",
    ".avi",
    ".mov",
    ".mkv",
    ".webm",
    ".zip",
    ".tar",
    ".gz",
    ".bz2",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".uasset",
    ".umap",
    ".ubulk",
    ".upk",
  ]);
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  return binaryExtensions.has(ext);
}

export const shelfRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]).optional(),
        authorId: z.string().optional(),
      }),
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          createdAt: z.date(),
          updatedAt: z.date(),
          name: z.string(),
          description: z.string(),
          repoId: z.string(),
          authorId: z.string(),
          versionIndex: z.string(),
          stateTree: z.any(),
          changelistNumber: z.int(),
          status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
          submittedToBranch: z.string().nullable(),
          submittedAt: z.date().nullable(),

          author: z.object({
            id: z.string(),
            name: z.string().nullable(),
            email: z.string(),
            image: z.string().nullable(),
          }),

          _count: z.object({
            fileChanges: z.number(),
          }),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const where: Prisma.ShelfWhereInput = { repoId: input.repoId };
      if (input.status) {
        where.status = input.status;
      } else {
        where.status = { not: "DELETED" };
      }
      if (input.authorId) {
        where.authorId = input.authorId;
      }

      return ctx.db.shelf.findMany({
        where,
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
          _count: { select: { fileChanges: true } },
        },
        orderBy: { updatedAt: "desc" },
      });
    }),

  get: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string(),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
        name: z.string(),
        description: z.string(),
        repoId: z.string(),
        authorId: z.string(),
        versionIndex: z.string(),
        stateTree: z.any(),
        changelistNumber: z.int(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
        submittedToBranch: z.string().nullable(),
        submittedAt: z.date().nullable(),

        author: z.object({
          id: z.string(),
          name: z.string().nullable(),
          email: z.string(),
          image: z.string().nullable(),
        }),

        fileChanges: z.array(
          z.object({
            file: z.object({
              id: z.string(),
              path: z.string(),
            }),
            type: z.string(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const shelf = await ctx.db.shelf.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: input.name },
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
          fileChanges: {
            include: {
              file: { select: { id: true, path: true } },
            },
          },
        },
      });

      if (!shelf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shelf not found" });
      }

      return shelf;
    }),

  create: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string().min(1).max(100),
        description: z.string().default(""),
        versionIndex: z.string(),
        modifications: z.array(
          z.object({
            path: z.string(),
            delete: z.boolean().default(false),
          }),
        ),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
        name: z.string(),
        description: z.string(),
        repoId: z.string(),
        authorId: z.string(),
        versionIndex: z.string(),
        stateTree: z.any(),
        changelistNumber: z.int(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
        submittedToBranch: z.string().nullable(),
        submittedAt: z.date().nullable(),

        author: z.object({
          id: z.string(),
          name: z.string().nullable(),
          email: z.string(),
          image: z.string().nullable(),
        }),

        fileChanges: z.array(
          z.object({
            file: z.object({
              id: z.string(),
              path: z.string(),
            }),
            type: z.string(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "shelves", ctx.db);

      // Check name uniqueness
      const existing = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.name } },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A shelf with this name already exists",
        });
      }

      // Allocate a CL number from the repo sequence
      const lastCl = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastCl?.number ?? -1) + 1;

      // Create File records and build stateTree
      const stateTree: Record<string, number> = {};
      const fileChangesData: { fileId: string; type: string }[] = [];

      const nonDeleteMods = input.modifications.filter((mod) => !mod.delete);
      const normalizedPaths = nonDeleteMods.map((mod) =>
        mod.path.replaceAll("\\\\", "/"),
      );

      const existingFiles = await ctx.db.file.findMany({
        where: {
          repoId: input.repoId,
          path: { in: normalizedPaths },
        },
      });

      const existingPathSet = new Set(existingFiles.map((f) => f.path));
      const newFilePaths = normalizedPaths.filter(
        (p) => !existingPathSet.has(p),
      );

      if (newFilePaths.length > 0) {
        await ctx.db.file.createMany({
          data: newFilePaths.map((path) => ({
            repoId: input.repoId,
            path,
          })),
        });

        const newFiles = await ctx.db.file.findMany({
          where: {
            repoId: input.repoId,
            path: { in: newFilePaths },
          },
        });
        existingFiles.push(...newFiles);
      }

      for (const mod of nonDeleteMods) {
        const modPath = mod.path.replaceAll("\\\\", "/");
        const file = existingFiles.find((f) => f.path === modPath);
        if (!file) continue;

        stateTree[file.id] = nextNumber;
        fileChangesData.push({ fileId: file.id, type: "ADD" });
      }

      // Create a dangling changelist (no parentNumber, no branch)
      await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: `Shelf: ${input.name}`,
          versionIndex: input.versionIndex,
          stateTree,
          repoId: input.repoId,
          userId: ctx.session.user.id,
          parentNumber: null,
        },
      });

      // Create the shelf
      const shelf = await ctx.db.shelf.create({
        data: {
          name: input.name,
          description: input.description,
          repoId: input.repoId,
          authorId: ctx.session.user.id,
          versionIndex: input.versionIndex,
          stateTree,
          changelistNumber: nextNumber,
          fileChanges: {
            create: fileChangesData,
          },
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
          fileChanges: {
            include: { file: { select: { id: true, path: true } } },
          },
        },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return shelf;
    }),

  addFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        versionIndex: z.string(),
        modifications: z.array(
          z.object({
            path: z.string(),
          }),
        ),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "shelves", ctx.db);

      const shelf = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.shelfName } },
        include: { fileChanges: true },
      });

      if (!shelf || shelf.status !== "ACTIVE") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Active shelf not found",
        });
      }

      // Build updated stateTree
      const stateTree: Record<string, number> = shelf.stateTree as Record<
        string,
        number
      >;

      const normalizedPaths = input.modifications.map((mod) =>
        mod.path.replaceAll("\\\\", "/"),
      );

      const existingFiles = await ctx.db.file.findMany({
        where: {
          repoId: input.repoId,
          path: { in: normalizedPaths },
        },
      });

      const existingPathSet = new Set(existingFiles.map((f) => f.path));
      const newFilePaths = normalizedPaths.filter(
        (p) => !existingPathSet.has(p),
      );

      if (newFilePaths.length > 0) {
        await ctx.db.file.createMany({
          data: newFilePaths.map((path) => ({
            repoId: input.repoId,
            path,
          })),
        });

        const newFiles = await ctx.db.file.findMany({
          where: {
            repoId: input.repoId,
            path: { in: newFilePaths },
          },
        });
        existingFiles.push(...newFiles);
      }

      const upsertEntries: { fileId: string }[] = [];
      for (const mod of input.modifications) {
        const modPath = mod.path.replaceAll("\\\\", "/");
        const file = existingFiles.find((f) => f.path === modPath);
        if (!file) continue;

        stateTree[file.id] = shelf.changelistNumber;
        upsertEntries.push({ fileId: file.id });
      }

      if (upsertEntries.length > 0) {
        const values = upsertEntries.map((entry) => {
          const id = crypto.randomUUID();
          return Prisma.sql`(${id}, ${shelf.id}, ${entry.fileId}, ${"ADD"})`;
        });

        await ctx.db.$executeRaw`
          INSERT INTO "ShelfFileChange" ("id", "shelfId", "fileId", "type")
          VALUES ${Prisma.join(values)}
          ON CONFLICT ("shelfId", "fileId") DO UPDATE SET "type" = ${"MODIFY"}
        `;
      }

      // Update the shelf and its dangling CL with new version index
      await ctx.db.shelf.update({
        where: { id: shelf.id },
        data: { versionIndex: input.versionIndex, stateTree },
      });

      await ctx.db.changelist.update({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: shelf.changelistNumber,
          },
        },
        data: { versionIndex: input.versionIndex, stateTree },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return { success: true };
    }),

  removeFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        versionIndex: z.string(),
        filePaths: z.array(z.string()),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "shelves", ctx.db);

      const shelf = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.shelfName } },
        include: { fileChanges: { include: { file: true } } },
      });

      if (!shelf || shelf.status !== "ACTIVE") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Active shelf not found",
        });
      }

      const stateTree: Record<string, number> = {
        ...(shelf.stateTree as Record<string, number>),
      };
      const normalizedPaths = input.filePaths.map((p) =>
        p.replaceAll("\\", "/"),
      );

      // Find files to remove
      const filesToRemove = shelf.fileChanges.filter((fc) =>
        normalizedPaths.includes(fc.file.path),
      );

      for (const fc of filesToRemove) {
        delete stateTree[fc.fileId];
      }

      // Delete the shelf file change records
      await ctx.db.shelfFileChange.deleteMany({
        where: {
          shelfId: shelf.id,
          fileId: { in: filesToRemove.map((fc) => fc.fileId) },
        },
      });

      // Update shelf and CL
      await ctx.db.shelf.update({
        where: { id: shelf.id },
        data: { versionIndex: input.versionIndex, stateTree },
      });

      await ctx.db.changelist.update({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: shelf.changelistNumber,
          },
        },
        data: { versionIndex: input.versionIndex, stateTree },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return { success: true };
    }),

  submitToBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        branchName: z.string(),
        message: z.string().optional(),
      }),
    )
    .output(
      z.object({
        changelistNumber: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "shelves", ctx.db);

      const shelf = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.shelfName } },
        include: { fileChanges: { include: { file: true } } },
      });

      if (!shelf || shelf.status !== "ACTIVE") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Active shelf not found",
        });
      }

      if (shelf.fileChanges.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Shelf has no files to submit",
        });
      }

      const branch = await ctx.db.branch.findFirst({
        where: { repoId: input.repoId, name: input.branchName },
      });

      if (!branch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch ${input.branchName} not found`,
        });
      }

      if (branch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Branch ${input.branchName} is archived`,
        });
      }

      // Get branch's current head
      const branchHead = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: branch.headNumber },
        },
      });

      if (!branchHead) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Branch head changelist not found",
        });
      }

      // Allocate a new CL number for the merge onto the branch
      const lastCl = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastCl?.number ?? -1) + 1;

      // Merge shelf state into branch state
      const branchState: Record<string, number> = {
        ...(branchHead.stateTree as Record<string, number>),
      };
      const shelfState: Record<string, number> = shelf.stateTree as Record<
        string,
        number
      >;

      for (const [fileId, clNum] of Object.entries(shelfState)) {
        branchState[fileId] = clNum;
      }

      const mergeMessage = input.message ?? `Applied shelf "${shelf.name}"`;

      // Create a new CL on the branch
      await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: mergeMessage,
          versionIndex: shelf.versionIndex,
          parentNumber: branch.headNumber,
          stateTree: branchState,
          repoId: input.repoId,
          userId: ctx.session.user.id,
        },
      });

      // Create file change records for the merge CL
      await ctx.db.fileChange.createMany({
        data: shelf.fileChanges.map((fc) => ({
          repoId: input.repoId,
          fileId: fc.fileId,
          changelistNumber: nextNumber,
          type: fc.type as FileChangeType,
        })),
      });

      // Update branch head
      await ctx.db.branch.update({
        where: { id: branch.id },
        data: { headNumber: nextNumber },
      });

      // Mark shelf as submitted
      await ctx.db.shelf.update({
        where: { id: shelf.id },
        data: {
          status: "SUBMITTED",
          submittedToBranch: input.branchName,
          submittedAt: new Date(),
        },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return { changelistNumber: nextNumber };
    }),

  // Called by the backend server during submit when shelfName is present.
  // Creates a dangling CL and shelf record (or updates existing shelf).
  createFromSubmit: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        description: z.string().default(""),
        versionIndex: z.string(),
        message: z.string(),
        modifications: z.array(
          z.object({
            delete: z.boolean(),
            path: z.string(),
            oldPath: z.string().optional(),
          }),
        ),
      }),
    )
    .output(
      z.object({
        shelfName: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "shelves", ctx.db);

      // Allocate next CL number
      const lastChangelist = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastChangelist?.number ?? -1) + 1;

      // Resolve file records for modifications (create new File entries as needed)
      const normalizedMods = input.modifications.map((mod) => ({
        ...mod,
        path: mod.path.replaceAll("\\", "/"),
      }));

      const existingFiles = await ctx.db.file.findMany({
        where: {
          repoId: input.repoId,
          path: { in: normalizedMods.map((m) => m.path) },
        },
      });

      const existingPathSet = new Set(existingFiles.map((f) => f.path));
      const newFilePaths = normalizedMods
        .filter((mod) => !mod.delete)
        .map((mod) => mod.path)
        .filter((p) => !existingPathSet.has(p));

      if (newFilePaths.length > 0) {
        await ctx.db.file.createMany({
          data: newFilePaths.map((path) => ({
            repoId: input.repoId,
            path,
          })),
        });

        const newFiles = await ctx.db.file.findMany({
          where: {
            repoId: input.repoId,
            path: { in: newFilePaths },
          },
        });
        existingFiles.push(...newFiles);
      }

      const fileIdsForPaths: Record<string, string | undefined> = {};
      for (const mod of normalizedMods) {
        const existingFile = existingFiles.find((f) => f.path === mod.path);
        fileIdsForPaths[mod.path] = existingFile?.id;
      }

      // Check if shelf already exists
      const existingShelf = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.shelfName } },
      });

      // Build stateTree: for existing shelf, merge with previous state; for new shelf, start fresh
      const stateTree: Record<string, number> =
        existingShelf?.status === "ACTIVE"
          ? { ...((existingShelf.stateTree as Record<string, number>) ?? {}) }
          : {};

      for (const mod of normalizedMods) {
        const fileId = fileIdsForPaths[mod.path];
        if (!fileId) continue;
        if (mod.delete) {
          delete stateTree[fileId];
        } else {
          stateTree[fileId] = nextNumber;
        }
      }

      // Create dangling changelist (no parent, no branch update)
      await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: input.message || `Shelf: ${input.shelfName}`,
          versionIndex: input.versionIndex,
          parentNumber: null,
          stateTree,
          repoId: input.repoId,
          userId: ctx.session.user.id,
        },
      });

      // Create FileChange records
      await ctx.db.fileChange.createMany({
        data: normalizedMods
          .filter((mod) => fileIdsForPaths[mod.path])
          .map((mod) => ({
            repoId: input.repoId,
            fileId: fileIdsForPaths[mod.path]!,
            changelistNumber: nextNumber,
            type: mod.delete ? FileChangeType.DELETE : FileChangeType.MODIFY,
            oldPath: mod.oldPath ? mod.oldPath.replaceAll("\\", "/") : null,
          })),
      });

      if (existingShelf?.status === "ACTIVE") {
        // Update existing shelf with new version index and state
        const upsertEntries = normalizedMods
          .filter((mod) => fileIdsForPaths[mod.path])
          .map((mod) => ({
            fileId: fileIdsForPaths[mod.path]!,
            type: mod.delete ? "DELETE" : "MODIFY",
          }));

        if (upsertEntries.length > 0) {
          const values = upsertEntries.map((entry) => {
            const id = crypto.randomUUID();
            return Prisma.sql`(${id}, ${existingShelf.id}, ${entry.fileId}, ${entry.type})`;
          });

          await ctx.db.$executeRaw`
            INSERT INTO "ShelfFileChange" ("id", "shelfId", "fileId", "type")
            VALUES ${Prisma.join(values)}
            ON CONFLICT ("shelfId", "fileId") DO UPDATE SET "type" = excluded."type"
          `;
        }

        await ctx.db.shelf.update({
          where: { id: existingShelf.id },
          data: {
            versionIndex: input.versionIndex,
            stateTree,
            changelistNumber: nextNumber,
          },
        });

        void recordActivity(ctx.db, {
          userId: ctx.session.user.id,
          orgId: repo.orgId,
          type: "write",
        });

        return { shelfName: existingShelf.name, changelistNumber: nextNumber };
      }

      // Create new shelf
      const shelf = await ctx.db.shelf.create({
        data: {
          name: input.shelfName,
          description: input.description,
          repoId: input.repoId,
          authorId: ctx.session.user.id,
          versionIndex: input.versionIndex,
          stateTree,
          changelistNumber: nextNumber,
          fileChanges: {
            create: normalizedMods
              .filter((mod) => fileIdsForPaths[mod.path] && !mod.delete)
              .map((mod) => ({
                fileId: fileIdsForPaths[mod.path]!,
                type: FileChangeType.ADD,
              })),
          },
        },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return { shelfName: shelf.name, changelistNumber: nextNumber };
    }),

  delete: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const shelf = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.shelfName } },
      });

      if (!shelf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shelf not found" });
      }

      await ctx.db.shelf.update({
        where: { id: shelf.id },
        data: { status: "DELETED" },
      });

      return { success: true };
    }),

  rename: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        newName: z.string().min(1).max(100),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
        name: z.string(),
        description: z.string(),
        repoId: z.string(),
        authorId: z.string(),
        versionIndex: z.string(),
        stateTree: z.any(),
        changelistNumber: z.int(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
        submittedToBranch: z.string().nullable(),
        submittedAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const shelf = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.shelfName } },
      });

      if (shelf?.status !== "ACTIVE") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Active shelf not found",
        });
      }

      // Check new name uniqueness
      const nameConflict = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.newName } },
      });
      if (nameConflict) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A shelf with that name already exists",
        });
      }

      return ctx.db.shelf.update({
        where: { id: shelf.id },
        data: { name: input.newName },
      });
    }),

  getFileContent: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        filePath: z.string(),
      }),
    )
    .output(
      z.object({
        content: z.string().nullable(),
        isBinary: z.boolean(),
        size: z.number(),
        tooLarge: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      const shelf = await ctx.db.shelf.findUnique({
        where: { repoId_name: { repoId: input.repoId, name: input.shelfName } },
      });

      if (!shelf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shelf not found" });
      }

      const binary = isBinaryFile(input.filePath);
      if (binary) {
        return { content: null, isBinary: true, size: 0, tooLarge: false };
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
        versionIndexName: shelf.versionIndex,
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
          return { content: "", isBinary: false, size: 0, tooLarge: false };
        }

        if (size > MAX_TEXT_SIZE) {
          return { content: null, isBinary: false, size, tooLarge: true };
        }

        return {
          content: data.toString("utf-8"),
          isBinary: false,
          size,
          tooLarge: false,
        };
      } finally {
        freeReadFileHandle(handle);
      }
    }),
});
