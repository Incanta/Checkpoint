import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Changelist } from "@prisma/client";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { FileChangeType, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";

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
        headNumber: z.number().default(0),
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

        // Feature branches can only be children of mainline or release
        if (input.type === "FEATURE" && parentBranch.type === "FEATURE") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Feature branches cannot be children of other feature branches",
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
      }

      // Mainline branches have no parent (even if created from a CL on another branch)
      const effectiveParent =
        input.type === "MAINLINE" ? null : input.parentBranchName;

      return ctx.db.branch.create({
        data: {
          repoId: input.repoId,
          name: input.name,
          headNumber: input.headNumber,
          isDefault: input.isDefault,
          type: input.type,
          parentBranchName: effectiveParent,
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

      return ctx.db.branch.update({
        where: { id: branch.id },
        data: { archivedAt: new Date() },
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
        data: { archivedAt: null },
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

      // Merge the state trees: incoming overwrites target
      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      const targetState: Record<string, number> = {
        ...(targetHead.stateTree as any),
      };
      const incomingState: Record<string, number> =
        incomingHead.stateTree as any;
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */

      for (const [fileId, clNum] of Object.entries(incomingState)) {
        targetState[fileId] = clNum;
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

      // Remove deleted files from the merged state
      for (const fc of fileChanges) {
        if (fc.type === FileChangeType.DELETE) {
          delete targetState[fc.fileId];
        }
      }

      // Get next CL number
      const lastCl = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastCl?.number ?? -1) + 1;

      // Create the squash merge changelist
      const mergeCl = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: mergeMessage,
          versionIndex: incomingHead.versionIndex,
          parentNumber: targetBranch.headNumber,
          stateTree: targetState,
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

      // Update the target branch headNumber
      await ctx.db.branch.update({
        where: { id: targetBranch.id },
        data: { headNumber: nextNumber },
      });

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
