import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import {
  findMergeBase,
  mergeBranch,
  updateBranchFromParent,
} from "~/server/branch-merge";
import { releaseClaimsForBranch } from "~/server/claims/claims";
import { resolveDomainBranchName } from "~/server/claims/domain";

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
        /**
         * Delete even though the branch has changelists its parent never
         * got. Without it such a delete is refused, listing them. The head
         * is kept either way (see restoreBranch).
         */
        discardUnmerged: z.boolean().default(false),
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

      // Work the parent never got: the branch's own changelists that the
      // parent's head cannot reach. Changelists that only brought the parent
      // in (updateFromParent) carry nothing of the branch's own.
      if (!input.discardUnmerged && branch.parentBranchName) {
        const parent = await ctx.db.branch.findUnique({
          where: {
            repoId_name: {
              repoId: input.repoId,
              name: branch.parentBranchName,
            },
          },
        });
        if (parent) {
          const mergeBase = await findMergeBase(
            ctx.db,
            input.repoId,
            parent.headNumber,
            branch.headNumber,
          );
          const own = mergeBase
            ? await ctx.db.changelist.findMany({
                where: {
                  repoId: input.repoId,
                  number: { in: mergeBase.incomingNumbers },
                  mergedFromNumber: null,
                },
                orderBy: { number: "desc" },
                select: { number: true, message: true },
              })
            : [];
          if (own.length > 0) {
            const listed = own
              .slice(0, 20)
              .map((cl) => `#${cl.number} ${cl.message.split("\n")[0]}`);
            if (own.length > 20) listed.push(`and ${own.length - 20} more`);
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                `${input.branchName} has ${own.length} changelist(s) ${branch.parentBranchName} never got. ` +
                `Merge it, or delete it with discardUnmerged to discard them (it can be restored):\n${listed.join("\n")}`,
            });
          }
        }
      }

      // Deleting a branch discards its work, so its claims release. Otherwise
      // the paths stay locked in the domain forever with nothing to unlock
      // them. The next claimant starts from the domain head, which does not
      // contain the discarded work, and the freshness gate agrees. One
      // transaction with the delete, and the head is kept so the branch can
      // be restored.
      return ctx.db.$transaction(async (tx) => {
        await releaseClaimsForBranch(tx, input.repoId, input.branchName, {
          userId: ctx.session.user.id,
        });
        await tx.deletedBranch.create({
          data: {
            repoId: input.repoId,
            name: branch.name,
            headNumber: branch.headNumber,
            type: branch.type,
            parentBranchName: branch.parentBranchName,
            domainBranchName: branch.domainBranchName,
            merged: false,
            deletedById: ctx.session.user.id,
          },
        });
        return tx.branch.delete({ where: { id: branch.id } });
      });
    }),

  /** Branches deleted (or deleted by their merge), newest first. */
  listDeletedBranches: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      return ctx.db.deletedBranch.findMany({
        where: { repoId: input.repoId },
        orderBy: { deletedAt: "desc" },
      });
    }),

  /**
   * Recreates a deleted branch at the head it had, under its old name or the
   * one given. Its parent must still exist (or another be named).
   */
  restoreBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        deletedBranchId: z.string(),
        name: z.string().min(1).optional(),
        parentBranchName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      const deleted = await ctx.db.deletedBranch.findFirst({
        where: { id: input.deletedBranchId, repoId: input.repoId },
      });
      if (!deleted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deleted branch not found",
        });
      }
      const name = input.name ?? deleted.name;
      const taken = await ctx.db.branch.findUnique({
        where: { repoId_name: { repoId: input.repoId, name } },
      });
      if (taken) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `A branch named ${name} exists; restore under another name`,
        });
      }
      const parentName = input.parentBranchName ?? deleted.parentBranchName;
      const parent = parentName
        ? await ctx.db.branch.findUnique({
            where: { repoId_name: { repoId: input.repoId, name: parentName } },
          })
        : null;
      if (parentName && !parent) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Its parent ${parentName} no longer exists; restore it onto another parent`,
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const restored = await tx.branch.create({
          data: {
            repoId: input.repoId,
            name,
            headNumber: deleted.headNumber,
            type: deleted.type,
            parentBranchName: parentName,
            isClaimDomainRoot: deleted.type !== "FEATURE",
            domainBranchName:
              deleted.type === "FEATURE"
                ? (parent?.domainBranchName ??
                  parent?.name ??
                  deleted.domainBranchName)
                : name,
            createdById: ctx.session.user.id,
          },
        });
        await tx.deletedBranch.delete({ where: { id: deleted.id } });
        return restored;
      });
    }),

  /**
   * Brings a feature branch's parent into it (see updateBranchFromParent):
   * what the parent changed since they last shared history lands on the
   * branch, and the branch can then merge without re-meeting those changes.
   */
  updateFromParent: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        branchName: z.string(),
        parentHeadNumber: z.number().int().nonnegative().optional(),
        resolvedInNumber: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<
        // Spelled out rather than named, so routers built on this one
        // (the daemon's) can name their own types.
        | { status: "up-to-date"; headNumber: number }
        | { status: "updated"; number: number; applied: number }
      > => {
        await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
        return updateBranchFromParent(ctx.db, {
          repoId: input.repoId,
          branchName: input.branchName,
          userId: ctx.session.user.id,
          ...(input.parentHeadNumber !== undefined && {
            parentHeadNumber: input.parentHeadNumber,
          }),
          ...(input.resolvedInNumber !== undefined && {
            resolvedInNumber: input.resolvedInNumber,
          }),
        });
      },
    ),

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

      const merged = await mergeBranch(ctx.db, {
        repoId: input.repoId,
        incomingBranchName: input.incomingBranchName,
        targetBranchName: input.targetBranchName,
        userId: ctx.session.user.id,
        requireParentRelation: true,
      });

      return {
        mergeChangelist: {
          id: merged.id,
          number: merged.number,
          message: merged.message,
        },
        deletedBranch: merged.deletedBranch,
      };
    }),
});
