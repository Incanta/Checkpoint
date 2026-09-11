import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Changelist } from "@prisma/client";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { FileChangeType, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import {
  getStateTreePaths,
  buildStateTreeBlocks,
  primeStateTreePaths,
} from "~/server/state-tree";
import { releaseClaimsForBranch } from "~/server/claims/claims";
import { settleClaimsForMerge } from "~/server/claims/landing";
import {
  resolveDomainBranchName,
  restackChildren,
} from "~/server/claims/domain";

export const branchRouter = createTRPCRouter({
  getBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const branch = await ctx.db.branch.findFirst({
        where: {
          repoId: input.repoId,
          name: input.name,
        },
        include: {
          createdBy: {
            select: { id: true, email: true, name: true, username: true },
          },
        },
      });

      return branch;
    }),

  listBranches: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        includeArchived: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const branches = await ctx.db.branch.findMany({
        where: {
          repoId: input.repoId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        include: {
          createdBy: {
            select: { id: true, email: true, name: true, username: true },
          },
        },
        orderBy: { name: "asc" },
      });

      return branches;
    }),

  createBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string().min(1),
        headNumber: z.number().default(-1),
        isDefault: z.boolean().default(false),
        type: z.enum(["MAINLINE", "RELEASE", "FEATURE"]).default("FEATURE"),
        parentBranchName: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);

      // Validate branch type constraints
      if (input.parentBranchName) {
        const parentBranch = await ctx.db.branch.findUnique({
          where: {
            repoId_name: {
              repoId: input.repoId,
              name: input.parentBranchName,
            },
          },
        });

        if (!parentBranch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Parent branch "${input.parentBranchName}" not found`,
          });
        }

        if (parentBranch.archivedAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot create a child of an archived branch",
          });
        }

        // Release branches can only be children of mainline
        if (input.type === "RELEASE" && parentBranch.type !== "MAINLINE") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Release branches can only be children of mainline branches",
          });
        }

        if (input.headNumber === -1) {
          input.headNumber = parentBranch.headNumber;
        }
      } else if (input.type !== "MAINLINE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only mainline branches can be created without a parent",
        });
      }

      // Mainline branches have no parent (even if created from a CL on another branch)
      const effectiveParent =
        input.type === "MAINLINE" ? null : input.parentBranchName;

      // Mainline and release branches anchor their own claim domain; feature
      // branches inherit their parent's. This is what isolates release work
      // from the mainline, and one mainline from another.
      const isClaimDomainRoot = input.type !== "FEATURE";

      const parent = effectiveParent
        ? await ctx.db.branch.findUnique({
            where: {
              repoId_name: { repoId: input.repoId, name: effectiveParent },
            },
          })
        : null;

      // Resolve rather than read the parent's column directly: a branch
      // stacked on a feature branch inherits the domain from further up, and
      // rows seeded before the column existed still need the walk.
      const domainBranchName =
        isClaimDomainRoot || !parent
          ? input.name
          : await resolveDomainBranchName(ctx.db, input.repoId, parent);

      return ctx.db.branch.create({
        data: {
          repoId: input.repoId,
          name: input.name,
          headNumber: input.headNumber,
          isDefault: input.isDefault,
          type: input.type,
          parentBranchName: effectiveParent,
          isClaimDomainRoot,
          domainBranchName,
          createdById: ctx.session.user.id,
        },
        include: {
          createdBy: {
            select: { id: true, email: true, name: true, username: true },
          },
        },
      });
    }),

  archiveBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        branchName: z.string(),
        /**
         * How this branch ended. "Discarded" archives it and releases its
         * claims; purgeable additionally marks its dangling changelists
         * eligible for a future garbage collection pass. Purgeability is
         * deliberately orthogonal to disposition: "discarded, keep the CLs
         * referenceable" and "discarded, reclaim the storage" differ only in
         * this flag.
         */
        disposition: z.enum(["MERGED", "DISCARDED"]).default("DISCARDED"),
        purgeable: z.boolean().default(false),
        /**
         * Archiving with claims still in flight strands committed binary work
         * with no owner and no signal, so it is refused unless the caller says
         * explicitly that discarding them is intended.
         */
        releaseOutstandingClaims: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { isAdmin } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const branch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: {
            repoId: input.repoId,
            name: input.branchName,
          },
        },
      });

      if (!branch) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Branch not found" });
      }

      if (branch.isDefault) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot archive the default mainline branch",
        });
      }

      // Permission: admins can archive any non-default, creators can archive their own feature branches
      const isCreator = branch.createdById === ctx.session.user.id;
      if (!isAdmin && !(isCreator && branch.type === "FEATURE")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to archive this branch",
        });
      }

      const outstanding = await ctx.db.fileClaim.count({
        where: {
          repoId: input.repoId,
          branchName: input.branchName,
          releasedAt: null,
        },
      });

      if (outstanding > 0 && !input.releaseOutstandingClaims) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `"${input.branchName}" still holds ${outstanding} claim${outstanding === 1 ? "" : "s"}. Merge, release, or confirm discarding them before archiving.`,
        });
      }

      if (outstanding > 0) {
        // Both discard flavours release. The work is not reaching the domain
        // root either way, so holding the path hostage forever is wrong;
        // purgeability is a separate question about content GC.
        await releaseClaimsForBranch(ctx.db, input.repoId, input.branchName, {
          userId: ctx.session.user.id,
        });
      }

      return ctx.db.branch.update({
        where: { id: branch.id },
        data: {
          archivedAt: new Date(),
          disposition: input.disposition,
          purgeable: input.purgeable,
        },
      });
    }),

  unarchiveBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { isAdmin } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const branch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: {
            repoId: input.repoId,
            name: input.branchName,
          },
        },
      });

      if (!branch) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Branch not found" });
      }

      const isCreator = branch.createdById === ctx.session.user.id;
      if (!isAdmin && !(isCreator && branch.type === "FEATURE")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to unarchive this branch",
        });
      }

      return ctx.db.branch.update({
        where: { id: branch.id },
        data: { archivedAt: null, disposition: "ACTIVE", purgeable: false },
      });
    }),

  deleteBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { isAdmin } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const branch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: {
            repoId: input.repoId,
            name: input.branchName,
          },
        },
      });

      if (!branch) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Branch not found" });
      }

      // Only feature branches can be deleted
      if (branch.type !== "FEATURE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only feature branches can be deleted",
        });
      }

      if (branch.isDefault) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot delete the default branch",
        });
      }

      const isCreator = branch.createdById === ctx.session.user.id;
      if (!isAdmin && !isCreator) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to delete this branch",
        });
      }

      // Check for child branches
      const children = await ctx.db.branch.findMany({
        where: { repoId: input.repoId, parentBranchName: input.branchName },
      });

      if (children.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Cannot delete a branch that has child branches. Delete or merge the children first.",
        });
      }

      // Deleting a branch discards its work, so its claims release. Otherwise
      // the paths stay locked in the domain forever with nothing to unlock
      // them. The next claimant starts from the domain head, which does not
      // contain the discarded work, and the freshness gate agrees.
      await releaseClaimsForBranch(ctx.db, input.repoId, input.branchName, {
        userId: ctx.session.user.id,
      });

      return ctx.db.branch.delete({
        where: { id: branch.id },
      });
    }),

  mergeBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        /** The feature branch being merged in */
        incomingBranchName: z.string(),
        /** The target branch (must be the parent of incoming) */
        targetBranchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);

      const incomingBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: {
            repoId: input.repoId,
            name: input.incomingBranchName,
          },
        },
      });

      if (!incomingBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Incoming branch "${input.incomingBranchName}" not found`,
        });
      }

      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: {
            repoId: input.repoId,
            name: input.targetBranchName,
          },
        },
      });

      if (!targetBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Target branch "${input.targetBranchName}" not found`,
        });
      }

      // Validate: only feature branches can be merged, into their parent
      if (incomingBranch.type !== "FEATURE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only feature branches can be merged",
        });
      }

      if (incomingBranch.parentBranchName !== targetBranch.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A feature branch can only be merged into its parent branch",
        });
      }

      if (targetBranch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot merge into an archived branch",
        });
      }

      if (incomingBranch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot merge an archived branch",
        });
      }

      // Collect all CLs on the incoming branch by walking from headNumber
      const incomingCls = [];
      let currentNumber: number | null = incomingBranch.headNumber;
      while (currentNumber !== null) {
        const cl: (Changelist & { user: { email: string } | null }) | null =
          await ctx.db.changelist.findUnique({
            where: {
              repoId_number: {
                repoId: input.repoId,
                number: currentNumber,
              },
            },
            include: {
              user: { select: { email: true } },
            },
          });

        if (!cl) break;
        incomingCls.push(cl);
        currentNumber = cl.parentNumber;

        // Stop if we reach the target branch's headNumber (common ancestor)
        if (
          cl.parentNumber !== null &&
          cl.parentNumber <= targetBranch.headNumber
        ) {
          break;
        }
      }

      if (incomingCls.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No changelists to merge",
        });
      }

      // Build the squash merge message
      const firstLine = `Merged ${input.incomingBranchName} into ${input.targetBranchName}`;
      const clMessages = incomingCls
        .map((cl) => `#${cl.number} ${cl.message}`)
        .join("\n");
      const mergeMessage = `${firstLine}\n\n${clMessages}`;

      // Get the head changelist of the incoming branch for the final state tree
      const incomingHead = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: incomingBranch.headNumber,
          },
        },
      });

      if (!incomingHead) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Could not find the incoming branch head changelist",
        });
      }

      // Get the target branch head for the current state tree
      const targetHead = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: targetBranch.headNumber,
          },
        },
      });

      if (!targetHead) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Could not find the target branch head changelist",
        });
      }

      // Merge the path trees: incoming overwrites target.
      const targetPaths = new Map(
        await getStateTreePaths(ctx.db, input.repoId, targetHead.number),
      );
      const incomingPaths = await getStateTreePaths(
        ctx.db,
        input.repoId,
        incomingHead.number,
      );
      for (const [path, clNum] of incomingPaths) {
        targetPaths.set(path, clNum);
      }

      // Merge artifact state trees: incoming overwrites target
      const targetArtifactState: Record<string, number> = {
        ...((targetHead.artifactStateTree as Record<string, number>) ?? {}),
      };
      const incomingArtifactState: Record<string, number> =
        (incomingHead.artifactStateTree as Record<string, number>) ?? {};

      for (const [fileId, clNum] of Object.entries(incomingArtifactState)) {
        targetArtifactState[fileId] = clNum;
      }

      // Collect all file changes from the incoming CLs
      const incomingClNumbers = incomingCls.map((cl) => cl.number);
      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: { in: incomingClNumbers },
        },
        include: { file: true },
      });

      // Remove deleted files from the merged path tree
      for (const fc of fileChanges) {
        if (fc.type === FileChangeType.DELETE) {
          targetPaths.delete(fc.file.path);
        }
      }

      // Get next CL number
      const lastCl = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastCl?.number ?? -1) + 1;

      // Build the merged state tree.
      const stateRootHash = await buildStateTreeBlocks(
        ctx.db,
        input.repoId,
        targetPaths.entries(),
      );

      // Create the squash merge changelist
      const mergeCl = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: mergeMessage,
          versionIndex: incomingHead.versionIndex,
          parentNumber: targetBranch.headNumber,
          stateRootHash,
          artifactVersionIndex: incomingHead.artifactVersionIndex,
          artifactStateTree:
            Object.keys(targetArtifactState).length > 0
              ? targetArtifactState
              : undefined,
          repoId: input.repoId,
          userId: ctx.session.user.id,
        },
      });

      // Create file change records for the merge CL
      // De-duplicate: keep the latest change type per file
      const latestFileChanges = new Map<
        string,
        { type: FileChangeType; oldPath: string | null }
      >();
      // Process in reverse order so earliest CLs are overwritten by latest
      for (const fc of fileChanges.sort(
        (a, b) => a.changelistNumber - b.changelistNumber,
      )) {
        latestFileChanges.set(fc.fileId, {
          type: fc.type,
          oldPath: fc.oldPath,
        });
      }

      if (latestFileChanges.size > 0) {
        await ctx.db.fileChange.createMany({
          data: Array.from(latestFileChanges.entries()).map(
            ([fileId, change]) => ({
              repoId: input.repoId,
              fileId,
              changelistNumber: nextNumber,
              type: change.type,
              oldPath: change.oldPath,
            }),
          ),
        });
      }

      primeStateTreePaths(input.repoId, stateRootHash, targetPaths);

      // Update the target branch headNumber
      await ctx.db.branch.update({
        where: { id: targetBranch.id },
        data: { headNumber: nextNumber },
      });

      // Settle claims the merge carried. Release when the target anchors its
      // own domain (the work has landed), advance onto the target otherwise
      // (a stacked branch merged one rung up, still in flight).
      await settleClaimsForMerge(ctx.db, {
        repoId: input.repoId,
        incomingBranchName: input.incomingBranchName,
        targetBranchName: input.targetBranchName,
        mergeChangelistNumber: nextNumber,
        paths: fileChanges.map((fc) => fc.file.path),
        actor: { userId: ctx.session.user.id },
      });

      // Restack: anything stacked on the merged branch re-parents to its
      // parent. Without this a stack deadlocks, because a branch can only
      // merge into its own parent and merging into an archived or deleted
      // branch is refused. Domains are unaffected, since a branch and its
      // parent always share one.
      await restackChildren(ctx.db, {
        repoId: input.repoId,
        mergedBranchName: input.incomingBranchName,
        newParentBranchName: input.targetBranchName,
      });

      // Release anything still held on the merged branch that the merge did
      // not carry (claims taken but never submitted).
      await releaseClaimsForBranch(
        ctx.db,
        input.repoId,
        input.incomingBranchName,
        { userId: ctx.session.user.id },
      );

      // Delete the incoming branch (CLs are preserved)
      await ctx.db.branch.delete({
        where: { id: incomingBranch.id },
      });

      return {
        mergeChangelist: {
          id: mergeCl.id,
          number: mergeCl.number,
          message: mergeCl.message,
        },
        deletedBranch: input.incomingBranchName,
      };
    }),
});
