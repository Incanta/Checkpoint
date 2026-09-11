import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { ClaimStrength, FileChangeType, RepoAccess } from "@prisma/client";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";
import { recordActivity } from "../activity";
import {
  getStateTreePaths,
  buildStateTreeBlocks,
  primeStateTreePaths,
  diffStateTrees,
} from "~/server/state-tree";
import type { InputJsonValue } from "@prisma/client/runtime/library";
import { walkChangelistAncestry } from "~/server/changelist-walk";
import { classifyPaths } from "~/server/team-sync/classify";
import { settleClaimsForSubmit } from "~/server/claims/claims";
import { resolveDomainBranchName } from "~/server/claims/domain";

export const changelistRouter = createTRPCRouter({
  // Path-keyed diff between two changelists' state trees. The daemon's sync
  // path: returns only changed paths + the source CLs to pull (no full map).
  diffChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        fromNumber: z.number(),
        toNumber: z.number(),
        // Resolve fileIds for added paths. The pull path needs them; the
        // sync-status path does not (and on a fresh full sync that set is the
        // whole repo, so resolving it dominates the cost). Defaults to true.
        resolveAddedFileIds: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      return diffStateTrees(
        ctx.db,
        input.repoId,
        input.fromNumber,
        input.toNumber,
        { resolveAddedFileIds: input.resolveAddedFileIds },
      );
    }),

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
        count: z.number().min(1).max(250),
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

      let resolvedStartNumber: number;
      if (typeof startNumber === "object") {
        // must be a date; find the first changelist at or before this date
        const startByDate = await ctx.db.changelist.findFirst({
          where: {
            repoId: input.repoId,
            createdAt: {
              lte: startNumber,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            number: true,
          },
        });

        if (!startByDate) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message:
              "Could not find a start number to retrieve changelists from",
          });
        }

        resolvedStartNumber = startByDate.number;
      } else {
        resolvedStartNumber = startNumber;
      }

      const { numbers } = await walkChangelistAncestry(
        ctx.db,
        input.repoId,
        resolvedStartNumber,
        input.count,
      );

      if (numbers.length === 0) {
        // the start changelist itself doesn't exist
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Could not find a start number to retrieve changelists from",
        });
      }

      const changelists = await ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: {
            in: numbers,
          },
        },
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
      });

      // findMany does not preserve order; restore newest-first walk order
      const byNumber = new Map(changelists.map((cl) => [cl.number, cl]));
      return numbers
        .map((number) => byNumber.get(number))
        .filter((cl) => cl !== undefined);
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

      const normalizedPaths = input.modifications.map((mod) =>
        mod.path.replaceAll("\\", "/"),
      );

      const submitBranch = await ctx.db.branch.findFirst({
        where: {
          repoId: input.repoId,
          name: input.branchName,
        },
      });

      if (!submitBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch ${input.branchName} not found in the repo`,
        });
      }

      if (submitBranch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Branch ${input.branchName} is archived and read-only`,
        });
      }

      // Resolve the claim domain this submit lands in. Claims anchored at
      // other domains (a release branch, another mainline) are irrelevant here
      // by design.
      const submitDomainBranchName = await resolveDomainBranchName(
        ctx.db,
        input.repoId,
        submitBranch,
      );

      const BATCH_SIZE = 20000;

      // Exclusion guard. The predicate spells out both index columns so the
      // planner uses the partial unique index and never scans advisory rows.
      // Holding the claim is the requirement: reclaiming is how another
      // workspace takes one over, which collapses the "started on main then
      // branched", collaborator, and cross-branch cases into one check.
      const blockingClaims: {
        file: { path: string };
        branchName: string;
        workspace: {
          user: { email: string; name: string | null; username: string | null };
        };
      }[] = [];

      for (let i = 0; i < normalizedPaths.length; i += BATCH_SIZE) {
        const batch = normalizedPaths.slice(i, i + BATCH_SIZE);
        const results = await ctx.db.fileClaim.findMany({
          where: {
            repoId: input.repoId,
            domainBranchName: submitDomainBranchName,
            releasedAt: null,
            strength: ClaimStrength.EXCLUSIVE,
            workspaceId: { not: input.workspaceId },
            file: {
              path: { in: batch },
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
        for (const r of results) blockingClaims.push(r);
      }

      if (blockingClaims.length > 0) {
        const blocked = blockingClaims.map((c) => {
          const displayName =
            c.workspace.user.name ||
            c.workspace.user.username ||
            c.workspace.user.email;
          return `${c.file.path} (claimed on "${c.branchName}" by ${displayName})`;
        });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Cannot submit: the following files are claimed by others in the "${submitDomainBranchName}" domain:\n${blocked.join("\n")}`,
        });
      }

      // Get the next changelist number
      const lastChangelist = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });

      const nextNumber = (lastChangelist?.number ?? -1) + 1;

      const branch = submitBranch;

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

      // Parent head's materialized path tree (cached); clone before mutating.
      const paths = new Map(
        await getStateTreePaths(ctx.db, input.repoId, branch.headNumber),
      );

      // Resolve / create File rows for the modified paths (for the FileChange
      // log and the fileId wire shim). Batched to avoid DB parameter limits.
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

      // Build a path→file map for O(1) lookups, record fileIds for the log, and
      // apply the modifications to the path tree.
      const filesByPath = new Map(modifiedFiles.map((f) => [f.path, f]));
      const fileIdsForPaths: Record<string, string | undefined> = {};
      for (const mod of input.modifications) {
        const modPath = mod.path.replaceAll("\\", "/");
        fileIdsForPaths[mod.path] = filesByPath.get(modPath)?.id;
        if (mod.delete) {
          paths.delete(modPath);
        } else {
          paths.set(modPath, nextNumber);
        }
      }

      // Build the content-addressed state tree and store its blocks.
      const stateRootHash = await buildStateTreeBlocks(
        ctx.db,
        input.repoId,
        paths.entries(),
      );

      // Classify code vs content from the modified paths (already in memory)
      const { hasCodeChanges, hasContentChanges } = classifyPaths(allPaths);

      // Create the changelist (inherit artifact state from parent)
      const changelist = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: input.message,
          versionIndex: input.versionIndex,
          parentNumber: branch.headNumber,
          stateRootHash,
          artifactVersionIndex: parentChangelist.artifactVersionIndex,
          artifactStateTree:
            parentChangelist.artifactStateTree as InputJsonValue,
          repoId: input.repoId,
          userId: ctx.session.user.id,
          hasCodeChanges,
          hasContentChanges,
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

      primeStateTreePaths(input.repoId, stateRootHash, paths);

      // Settle claims for everything this changelist carried.
      //
      // Submitting to the domain root closes the gap between "the change
      // exists somewhere" and "the change reached the root" in this same
      // transaction, so those claims release outright. Submitting to a feature
      // branch parks them as SUBMITTED: still blocking the domain, but
      // reclaimable by anyone on that branch or below it.
      //
      // Paths that were never checked out get a claim created here, at the
      // strength the org's binary-extension set resolves to. This is the only
      // claim-creation point that can fail a submit, because the claim is
      // taken after the work rather than before it.
      await settleClaimsForSubmit(ctx.db, {
        repoId: input.repoId,
        branchName: input.branchName,
        domainBranchName: submitDomainBranchName,
        targetIsDomainRoot: submitDomainBranchName === input.branchName,
        changelistNumber: nextNumber,
        fileIdsForPaths,
        orgBinaryExtensions: repo.org.binaryExtensions,
        keepCheckedOut: input.keepCheckedOut,
        actor: {
          userId: ctx.session.user.id,
          workspaceId: input.workspaceId,
        },
      });

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
        /** The older CL number (exclusive: changes IN this CL are NOT included). */
        fromNumber: z.number(),
        /** The newer CL number (inclusive: we start here and walk back). */
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
