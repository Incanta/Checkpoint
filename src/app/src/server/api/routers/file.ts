import { z } from "zod";
import { TRPCError } from "@trpc/server";
import config from "@incanta/config";
import {
  readFileFromVersionAsync,
  pollReadFileHandle,
  freeReadFileHandle,
  GetLogLevel,
} from "@checkpointvcs/longtail-addon";

import { resolveFileSource } from "~/server/read-file-at-changelist";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { ClaimEventType, ClaimStrength, RepoAccess } from "@prisma/client";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";
import { recordActivity } from "../activity";
import {
  resolveBinaryExtensions,
  isBinaryFile,
} from "~/server/binary-extensions";
import {
  listStateTreeDir,
  lookupStateTreePaths,
  stateTreeFileCount,
} from "~/server/state-tree";
import { buildAddonStorageOptions } from "~/server/storage-options";
import {
  acquireClaim,
  moveClaim,
  releaseClaim as releaseClaimRecord,
} from "~/server/claims/claims";
import { reconcileClaims } from "~/server/claims/landing";
import {
  resolveDomainBranchName,
  resolveWorkspaceBranch,
} from "~/server/claims/domain";
import { compareNames } from "~/lib/file-tree-sort";

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

      // Scoped to the repo the access check was for: ids alone would return
      // any repo's files to anyone who can read some repo.
      return ctx.db.file.findMany({
        where: {
          repoId: input.repoId,
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

  getWorkspaceClaims: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        repoId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      await assertWorkspaceOwnership(ctx, input.workspaceId, input.repoId);

      const claims = await ctx.db.fileClaim.findMany({
        where: {
          workspaceId: input.workspaceId,
          releasedAt: null,
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

      // Same shape as getClaimsForFiles so the daemon can build `File.claims`
      // from either source. `blocking` is always false here: these are the
      // caller's own claims, and nobody is blocked by themselves.
      return claims.map((c) => ({
        id: c.id,
        fileId: c.fileId,
        filePath: c.file.path,
        strength: c.strength,
        state: c.state,
        branchName: c.branchName,
        domainBranchName: c.domainBranchName,
        blocking: false,
        workspaceId: c.workspaceId,
        userId: c.workspace.userId,
        user: c.workspace.user,
      }));
    }),

  getClaimsForFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        filePaths: z.array(z.string()),
        /**
         * The branch asking. Claims in the caller's own domain block them;
         * claims in a sibling domain (a release branch, another mainline) are
         * returned as context only.
         */
        branchName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const normalizedPaths = input.filePaths.map((p) =>
        p.replaceAll("\\", "/"),
      );

      let callerDomain: string | null = null;
      if (input.branchName) {
        const branch = await ctx.db.branch.findUnique({
          where: {
            repoId_name: { repoId: input.repoId, name: input.branchName },
          },
        });
        if (branch) {
          callerDomain = await resolveDomainBranchName(
            ctx.db,
            input.repoId,
            branch,
          );
        }
      }

      const claims = await ctx.db.fileClaim.findMany({
        where: {
          repoId: input.repoId,
          releasedAt: null,
          file: { path: { in: normalizedPaths } },
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

      // Lazy reconcile: drop anything whose content already reached its domain
      // root by a route other than a merge of the holding branch.
      const reconciled = await reconcileClaims(ctx.db, input.repoId, claims);

      return claims
        .filter((c) => !reconciled.has(c.id))
        .map((c) => ({
          id: c.id,
          fileId: c.fileId,
          filePath: c.file.path,
          strength: c.strength,
          state: c.state,
          branchName: c.branchName,
          domainBranchName: c.domainBranchName,
          /**
           * Whether this claim actually blocks the asking branch. False for
           * advisory claims and for claims anchored in another domain.
           */
          blocking:
            c.strength === ClaimStrength.EXCLUSIVE &&
            (callerDomain === null || c.domainBranchName === callerDomain),
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
        /**
         * The branch the work is happening on. Defaults to the workspace's
         * domain root when the caller does not say.
         */
        branchName: z.string().optional(),
        /**
         * Bypasses strength resolution and takes an exclusive claim on a path
         * the binary-extension set considers mergeable. This is how a user
         * says "I am taking this file through a large refactor, keep everyone
         * off it". Any writer may pass it.
         */
        forceExclusive: z.boolean().default(false),
        /**
         * Move this workspace's own open claim on the path to `branchName`
         * (within its domain) instead of adding another. What staging into a
         * branch means; a plain checkout leaves an existing claim where it
         * is.
         */
        moveExisting: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertWorkspaceOwnership(ctx, input.workspaceId, input.repoId);

      const normalizedPath = input.filePath.replaceAll("\\", "/");

      const workspace = await ctx.db.workspace.findUnique({
        where: { id: input.workspaceId },
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const branchName = await resolveWorkspaceBranch(
        ctx.db,
        input.repoId,
        workspace,
        input.branchName,
      );

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

      const { claim } = await (input.moveExisting ? moveClaim : acquireClaim)(
        ctx.db,
        {
          repoId: input.repoId,
          fileId: file.id,
          filePath: normalizedPath,
          branchName,
          orgBinaryExtensions: repo.org.binaryExtensions,
          forceExclusive: input.forceExclusive,
          actor: {
            userId: ctx.session.user.id,
            workspaceId: input.workspaceId,
          },
          syncedChangelistNumber: workspace.syncedChangelistNumber,
        },
      );

      // Record write activity for billing (fire-and-forget)
      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return claim;
    }),

  releaseClaim: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        workspaceId: z.string(),
        filePath: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      await assertWorkspaceOwnership(ctx, input.workspaceId, input.repoId);

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

      const claim = await ctx.db.fileClaim.findFirst({
        where: {
          fileId: file.id,
          workspaceId: input.workspaceId,
          releasedAt: null,
        },
      });

      if (!claim) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No active claim found for this file",
        });
      }

      await releaseClaimRecord(ctx.db, claim, {
        userId: ctx.session.user.id,
        workspaceId: input.workspaceId,
      });

      return { success: true };
    }),

  getRepoClaims: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        exclusiveOnly: z.boolean().default(false),
        /** Restrict to one claim domain. Omit for every domain in the repo. */
        domainBranchName: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const claims = await ctx.db.fileClaim.findMany({
        where: {
          repoId: input.repoId,
          releasedAt: null,
          ...(input.exclusiveOnly && { strength: ClaimStrength.EXCLUSIVE }),
          ...(input.domainBranchName && {
            domainBranchName: input.domainBranchName,
          }),
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
        orderBy: { createdAt: "desc" },
      });

      const reconciled = await reconcileClaims(ctx.db, input.repoId, claims);

      return claims
        .filter((c) => !reconciled.has(c.id))
        .map((c) => ({
          id: c.id,
          fileId: c.fileId,
          filePath: c.file.path,
          strength: c.strength,
          state: c.state,
          branchName: c.branchName,
          domainBranchName: c.domainBranchName,
          createdAt: c.createdAt,
          workspaceId: c.workspaceId,
          workspaceName: c.workspace.name,
          userId: c.workspace.userId,
          user: c.workspace.user,
        }));
    }),

  forceReleaseClaim: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        claimId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.ADMIN);

      const claim = await ctx.db.fileClaim.findFirst({
        where: {
          id: input.claimId,
          repoId: input.repoId,
          releasedAt: null,
        },
      });

      if (!claim) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No active claim found",
        });
      }

      await releaseClaimRecord(
        ctx.db,
        claim,
        { userId: ctx.session.user.id },
        ClaimEventType.FORCE_RELEASE,
      );

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
        select: { artifactStateTree: true, stateRootHash: true },
      });

      if (!changelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Changelist not found",
        });
      }

      const folderPath = input.folderPath.replace(/\/+$/, "");
      const prefix = folderPath === "" ? "" : `${folderPath}/`;

      // The requested folder straight from the tree: only the blocks on the
      // way to it and the folder itself are read.
      const listing = await listStateTreeDir(
        ctx.db,
        input.repoId,
        changelist.stateRootHash,
        folderPath,
      );
      const folders = new Set<string>(listing?.dirs ?? []);
      const files: {
        name: string;
        path: string;
        lastCl: number;
        isArtifact: boolean;
      }[] = (listing?.files ?? []).map((f) => ({
        name: f.name,
        path: prefix + f.name,
        lastCl: f.cl,
        isArtifact: false,
      }));

      // The artifact overlay is still a fileId-keyed blob; convert it to paths
      // via the File table (only when artifacts are requested), loading just
      // the rows it names.
      const artifactRaw = input.includeArtifacts
        ? ((changelist.artifactStateTree as Record<string, number> | null) ??
          {})
        : {};
      const artifactPaths = new Map<string, number>();
      const artifactIds = Object.keys(artifactRaw);
      for (let i = 0; i < artifactIds.length; i += 500) {
        const rows = await ctx.db.file.findMany({
          where: { repoId: input.repoId, id: { in: artifactIds.slice(i, i + 500) } },
          select: { id: true, path: true },
        });
        for (const row of rows) artifactPaths.set(row.path, artifactRaw[row.id]!);
      }

      // Artifact paths that main does not also have add to the listing and
      // to the total; main's own entries win where both exist.
      const mainHasArtifactPath = await lookupStateTreePaths(
        ctx.db,
        input.repoId,
        changelist.stateRootHash,
        artifactPaths.keys(),
      );
      let artifactOnly = 0;
      const listed = new Set(files.map((f) => f.path));
      for (const [filePath, cl] of artifactPaths) {
        if (mainHasArtifactPath.has(filePath)) continue;
        artifactOnly++;
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        const slashIndex = remainder.indexOf("/");
        if (slashIndex === -1) {
          if (!listed.has(filePath)) {
            files.push({ name: remainder, path: filePath, lastCl: cl, isArtifact: true });
          }
        } else {
          folders.add(remainder.slice(0, slashIndex));
        }
      }
      for (const f of files) {
        if (artifactPaths.has(f.path)) f.isArtifact = true;
      }

      const totalFileCount =
        (await stateTreeFileCount(ctx.db, input.repoId, input.changelistNumber)) +
        artifactOnly;

      // Folders and files are returned as separate lists, so the browse UI
      // already renders directories first; this only settles name order.
      return {
        folders: [...folders].sort(compareNames),
        files: files.sort((a, b) => compareNames(a.name, b.name)),
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

      // Which changelist holds this file's content as of the requested one.
      const source = await resolveFileSource(
        ctx.db,
        input.repoId,
        input.filePath,
        input.changelistNumber,
      );

      if (!source) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found in changelist history",
        });
      }

      const binaryExts = resolveBinaryExtensions(repo.org.binaryExtensions);
      const binary = isBinaryFile(input.filePath, binaryExts);

      // For binary files, return metadata only (no content)
      if (binary) {
        return { content: null, isBinary: true, size: 0 };
      }

      const remoteBasePath = `/${repo.orgId}/${repo.id}`;

      const storageOptions = await buildAddonStorageOptions(
        ctx.session.user.id,
        repo,
        false,
      );

      const logLevel = GetLogLevel(
        config.get<string>(
          "logging.longtail-level",
        ) as import("@checkpointvcs/longtail-addon").LongtailLogLevel,
      );

      const handle = readFileFromVersionAsync({
        filePath: input.filePath,
        versionIndexName: source.versionIndex,
        remoteBasePath,
        ...storageOptions,
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
