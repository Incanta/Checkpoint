import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { FileChangeType, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import { hasFeature, isLicenseManager, type LicenseTier } from "~/server/license-utils";
import { getInstanceTier } from "~/server/license-client";

async function assertArtifactFeature(orgId: string, db: any) {
  if (isLicenseManager()) {
    const org = await db.org.findUnique({
      where: { id: orgId },
      select: { subscriptionTier: true },
    });
    if (!hasFeature((org?.subscriptionTier ?? "BASIC") as LicenseTier, "artifacts")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Artifacts require a Pro or higher subscription" });
    }
  } else {
    if (!hasFeature(getInstanceTier(), "artifacts")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Artifacts require a Pro or higher license" });
    }
  }
}

export const artifactRouter = createTRPCRouter({
  // Called by the backend server when CI uploads artifacts for an existing CL.
  // Merges new artifact files into the CL's artifactStateTree (additive overwrite).
  attachToChangelist: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        versionIndex: z.string(),
        modifications: z.array(
          z.object({
            delete: z.boolean(),
            path: z.string(),
            oldPath: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      await assertArtifactFeature(repo.orgId, ctx.db);

      const changelist = await ctx.db.changelist.findUnique({
        where: { repoId_number: { repoId: input.repoId, number: input.changelistNumber } },
      });

      if (!changelist) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Changelist ${input.changelistNumber} not found` });
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

      const fileIdsForPaths: Record<string, string | undefined> = {};
      for (const mod of normalizedMods) {
        let existingFile = existingFiles.find((f: any) => f.path === mod.path);

        if (!existingFile && !mod.delete) {
          existingFile = await ctx.db.file.create({
            data: { repoId: input.repoId, path: mod.path },
          });
        }

        fileIdsForPaths[mod.path] = existingFile?.id;
      }

      // Merge into existing artifact state tree (additive overwrite)
      const artifactStateTree: Record<string, number> = {
        ...(changelist.artifactStateTree as Record<string, number> ?? {}),
      };

      for (const mod of normalizedMods) {
        const fileId = fileIdsForPaths[mod.path];
        if (!fileId) continue;
        if (mod.delete) {
          delete artifactStateTree[fileId];
        } else {
          artifactStateTree[fileId] = input.changelistNumber;
        }
      }

      // Update CL with new artifact version index and merged state tree
      await ctx.db.changelist.update({
        where: { id: changelist.id },
        data: {
          artifactVersionIndex: input.versionIndex,
          artifactStateTree,
        },
      });

      // Upsert ArtifactFile records
      for (const mod of normalizedMods) {
        const fileId = fileIdsForPaths[mod.path];
        if (!fileId) continue;

        if (mod.delete) {
          await ctx.db.artifactFile.deleteMany({
            where: {
              repoId: input.repoId,
              changelistNumber: input.changelistNumber,
              fileId,
            },
          });
        } else {
          await ctx.db.artifactFile.upsert({
            where: {
              repoId_changelistNumber_fileId: {
                repoId: input.repoId,
                changelistNumber: input.changelistNumber,
                fileId,
              },
            },
            create: {
              repoId: input.repoId,
              changelistNumber: input.changelistNumber,
              fileId,
              size: BigInt(0), // Size determined by longtail; updated if provided
            },
            update: {
              size: BigInt(0),
            },
          });
        }
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

      return artifacts.map((a: any) => ({
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

      return changelists.map((cl: any) => cl.number);
    }),
});
