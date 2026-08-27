import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { Prisma, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import { assertFeature } from "~/server/license-client";
import { walkChangelistAncestry } from "~/server/changelist-walk";

const artifactTypeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .default("editor");

export const artifactRouter = createTRPCRouter({
  // Called by the backend server when CI uploads artifacts for an existing CL.
  // Merges new artifact files into the CL's artifactStateTree (additive overwrite).
  attachToChangelist: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        versionIndex: z.string(),
        // Artifact channel; existing callers omit it and get "editor".
        type: artifactTypeSchema,
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
        changelistNumber: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertFeature(repo.orgId, "artifacts", ctx.db);

      const changelist = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.changelistNumber,
          },
        },
      });

      if (!changelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Changelist ${input.changelistNumber} not found`,
        });
      }

      // Resolve file records for modifications
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

      // Merge into the typed ArtifactSet for this (CL, type). Base is the
      // existing set at this exact CL; for "editor" we fall back to the CL's
      // (possibly inherited) legacy overlay so repeat attaches stay cumulative.
      const existingSet = await ctx.db.artifactSet.findUnique({
        where: {
          repoId_changelistNumber_type: {
            repoId: input.repoId,
            changelistNumber: input.changelistNumber,
            type: input.type,
          },
        },
      });

      const baseStateTree =
        (existingSet?.stateTree as Record<string, number> | null) ??
        (input.type === "editor"
          ? ((changelist.artifactStateTree as Record<string, number> | null) ??
            {})
          : {});

      const artifactStateTree: Record<string, number> = { ...baseStateTree };

      for (const mod of normalizedMods) {
        const fileId = fileIdsForPaths[mod.path];
        if (!fileId) continue;
        if (mod.delete) {
          delete artifactStateTree[fileId];
        } else {
          artifactStateTree[fileId] = input.changelistNumber;
        }
      }

      await ctx.db.artifactSet.upsert({
        where: {
          repoId_changelistNumber_type: {
            repoId: input.repoId,
            changelistNumber: input.changelistNumber,
            type: input.type,
          },
        },
        create: {
          repoId: input.repoId,
          changelistNumber: input.changelistNumber,
          type: input.type,
          versionIndex: input.versionIndex,
          stateTree: artifactStateTree,
        },
        update: {
          versionIndex: input.versionIndex,
          stateTree: artifactStateTree,
        },
      });

      // Keep writing the legacy overlay for the "editor" channel so existing
      // daemon pull flows and CL-inheritance keep working unchanged.
      if (input.type === "editor") {
        await ctx.db.changelist.update({
          where: { id: changelist.id },
          data: {
            artifactVersionIndex: input.versionIndex,
            artifactStateTree,
          },
        });
      }

      // Batch upsert/delete ArtifactFile records
      const deleteFileIds = normalizedMods
        .filter((mod) => mod.delete && fileIdsForPaths[mod.path])
        .map((mod) => fileIdsForPaths[mod.path]!);

      if (deleteFileIds.length > 0) {
        await ctx.db.artifactFile.deleteMany({
          where: {
            repoId: input.repoId,
            changelistNumber: input.changelistNumber,
            type: input.type,
            fileId: { in: deleteFileIds },
          },
        });
      }

      const upsertMods = normalizedMods.filter(
        (mod) => !mod.delete && fileIdsForPaths[mod.path],
      );

      if (upsertMods.length > 0) {
        const now = new Date().toISOString();
        const values = upsertMods.map((mod) => {
          const fileId = fileIdsForPaths[mod.path]!;
          const id = crypto.randomUUID();
          return Prisma.sql`(${id}, ${now}, ${input.repoId}, ${input.changelistNumber}, ${input.type}, ${fileId}, ${BigInt(0)})`;
        });

        await ctx.db.$executeRaw`
          INSERT INTO "ArtifactFile" ("id", "createdAt", "repoId", "changelistNumber", "type", "fileId", "size")
          VALUES ${Prisma.join(values)}
          ON CONFLICT ("repoId", "changelistNumber", "type", "fileId") DO UPDATE SET "size" = ${BigInt(0)}
        `;
      }

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return { changelistNumber: input.changelistNumber };
    }),

  // List artifact files for a specific changelist
  list: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          fileId: z.string(),
          path: z.string(),
          size: z.number(),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const artifacts = await ctx.db.artifactFile.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: input.changelistNumber,
        },
        include: {
          file: { select: { id: true, path: true } },
        },
        orderBy: { file: { path: "asc" } },
      });

      return artifacts.map((a) => ({
        id: a.id,
        fileId: a.file.id,
        path: a.file.path,
        size: Number(a.size),
        createdAt: a.createdAt,
      }));
    }),

  // Batch query: which of the given CL numbers have artifacts?
  getForChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumbers: z.array(z.number()),
      }),
    )
    .output(z.array(z.number()))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const changelists = await ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: { in: input.changelistNumbers },
          artifactVersionIndex: { not: null },
        },
        select: { number: true },
      });

      return changelists.map((cl) => cl.number);
    }),

  // Batch query: which artifact set types are EXACTLY attached at each of the
  // given CLs? Unlike getForChangelists this does not report inherited
  // overlays, so it is the right source for browser "binaries built here"
  // indicators.
  getSetsForChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumbers: z.array(z.number()).max(250),
      }),
    )
    .output(z.record(z.string(), z.array(z.string())))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const sets = await ctx.db.artifactSet.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: { in: input.changelistNumbers },
        },
        select: { changelistNumber: true, type: true },
      });

      const result: Record<string, string[]> = {};
      for (const set of sets) {
        (result[String(set.changelistNumber)] ??= []).push(set.type);
      }
      return result;
    }),

  // List the artifact sets attached exactly at a changelist.
  listSets: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .output(
      z.array(
        z.object({
          type: z.string(),
          versionIndex: z.string(),
          fileCount: z.number(),
          updatedAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const sets = await ctx.db.artifactSet.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: input.changelistNumber,
        },
        orderBy: { type: "asc" },
      });

      return sets.map((set) => ({
        type: set.type,
        versionIndex: set.versionIndex,
        fileCount: Object.keys(
          (set.stateTree as Record<string, number> | null) ?? {},
        ).length,
        updatedAt: set.updatedAt,
      }));
    }),

  // Find the newest artifact set of `type` at or before `maxChangelistNumber`
  // on the ancestor chain, optionally gated on required badges being SUCCESS
  // at the set's changelist (UGS RequiredBadges parity). This is the daemon's
  // lookup for "which binaries should I apply when synced to CL X".
  findLatestSet: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        type: artifactTypeSchema,
        maxChangelistNumber: z.number(),
        requiredBadges: z.array(z.string().min(1)).optional(),
        maxScan: z.number().int().min(1).max(2000).default(200),
      }),
    )
    .output(
      z
        .object({
          changelistNumber: z.number(),
          versionIndex: z.string(),
          stateTree: z.record(z.string(), z.number()),
        })
        .nullable(),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );
      await assertFeature(repo.orgId, "artifacts", ctx.db);

      const pageSize = 250;
      let cursor: number | null = input.maxChangelistNumber;
      let scanned = 0;

      while (cursor !== null && scanned < input.maxScan) {
        const limit = Math.min(pageSize, input.maxScan - scanned);
        const { numbers, nextNumber } = await walkChangelistAncestry(
          ctx.db,
          input.repoId,
          cursor,
          limit,
        );

        if (numbers.length === 0) {
          break;
        }
        scanned += numbers.length;

        const sets = await ctx.db.artifactSet.findMany({
          where: {
            repoId: input.repoId,
            type: input.type,
            changelistNumber: { in: numbers },
          },
        });

        if (sets.length > 0) {
          const setsByNumber = new Map(
            sets.map((set) => [set.changelistNumber, set]),
          );
          const candidates = numbers.filter((number) =>
            setsByNumber.has(number),
          );

          const requiredBadges = input.requiredBadges ?? [];
          let chosenNumber: number | undefined;

          if (requiredBadges.length === 0) {
            chosenNumber = candidates[0];
          } else {
            const badges = await ctx.db.buildBadge.findMany({
              where: {
                repoId: input.repoId,
                changelistNumber: { in: candidates },
                name: { in: requiredBadges },
              },
              select: { changelistNumber: true, name: true, state: true },
            });

            chosenNumber = candidates.find((number) =>
              requiredBadges.every((name) =>
                badges.some(
                  (badge) =>
                    badge.changelistNumber === number &&
                    badge.name === name &&
                    badge.state === "SUCCESS",
                ),
              ),
            );
          }

          if (chosenNumber !== undefined) {
            const chosen = setsByNumber.get(chosenNumber)!;
            return {
              changelistNumber: chosen.changelistNumber,
              versionIndex: chosen.versionIndex,
              stateTree:
                (chosen.stateTree as Record<string, number> | null) ?? {},
            };
          }
        }

        cursor = nextNumber;
      }

      return null;
    }),
});
