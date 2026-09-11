import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";
import { RepoAccess } from "@prisma/client";
import { resolveDomainBranchName } from "~/server/claims/domain";

export const workspaceRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.workspace.findMany({
      where: {
        deletedAt: null,
        userId: ctx.session.user.id,
      },
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        repoId: z.string(),
        defaultBranchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      const newWorkspace = await ctx.db.workspace.create({
        data: {
          name: input.name,
          userId: ctx.session.user.id,
          repoId: input.repoId,
          orgId: repo.orgId,
          domainBranchName: input.defaultBranchName,
        },
      });

      return newWorkspace;
    }),

  /**
   * Reports the workspace's branch state to the server.
   *
   * Claims are attributed per branch and taken at checkout time, so the server
   * needs to know the branch then, not only at submit. `activeBranches` is the
   * set of feature branches overlaid on the tree; empty means the workspace is
   * working directly on its domain root, which is what every workspace did
   * before multi-branch workspaces existed.
   */
  setBranchState: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        domainBranchName: z.string(),
        activeBranches: z.array(z.string()).default([]),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      const workspace = await ctx.db.workspace.findUnique({
        where: { id: input.workspaceId },
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const domain = await ctx.db.branch.findUnique({
        where: {
          repoId_name: {
            repoId: workspace.repoId,
            name: input.domainBranchName,
          },
        },
      });

      if (!domain) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch "${input.domainBranchName}" not found`,
        });
      }

      if (!domain.isClaimDomainRoot) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${input.domainBranchName}" is not a domain root. A workspace materializes from a mainline or release branch and overlays feature branches on top.`,
        });
      }

      // A stacked branch expresses its changes relative to its parent, so it
      // cannot be overlaid alone: activating it activates its whole ancestor
      // chain. Validate that the client sent complete chains rather than
      // silently producing a tree that is missing a layer.
      const active = new Set(input.activeBranches);
      for (const branchName of input.activeBranches) {
        const branch = await ctx.db.branch.findUnique({
          where: { repoId_name: { repoId: workspace.repoId, name: branchName } },
        });

        if (!branch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Branch "${branchName}" not found`,
          });
        }

        const branchDomain = await resolveDomainBranchName(
          ctx.db,
          workspace.repoId,
          branch,
        );

        if (branchDomain !== input.domainBranchName) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `"${branchName}" belongs to the "${branchDomain}" domain and cannot be overlaid on "${input.domainBranchName}"`,
          });
        }

        if (
          branch.parentBranchName &&
          branch.parentBranchName !== input.domainBranchName &&
          !active.has(branch.parentBranchName)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `"${branchName}" is stacked on "${branch.parentBranchName}", which must be active too`,
          });
        }
      }

      // A cross-domain move cannot carry claims: they are anchored to the
      // domain they were taken in, and re-anchoring would silently validate
      // against a domain that may already hold the path.
      if (
        workspace.domainBranchName &&
        workspace.domainBranchName !== input.domainBranchName
      ) {
        const outstanding = await ctx.db.fileClaim.count({
          where: {
            workspaceId: input.workspaceId,
            releasedAt: null,
            domainBranchName: workspace.domainBranchName,
          },
        });

        if (outstanding > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `This workspace holds ${outstanding} claim${outstanding === 1 ? "" : "s"} in the "${workspace.domainBranchName}" domain. Submit, shelve, or release them before switching to "${input.domainBranchName}".`,
          });
        }
      }

      await ctx.db.$transaction([
        ctx.db.workspace.update({
          where: { id: input.workspaceId },
          data: { domainBranchName: input.domainBranchName },
        }),
        ctx.db.workspaceBranch.deleteMany({
          where: {
            workspaceId: input.workspaceId,
            branchName: { notIn: input.activeBranches },
          },
        }),
        ...input.activeBranches.map((branchName) =>
          ctx.db.workspaceBranch.upsert({
            where: {
              workspaceId_branchName: {
                workspaceId: input.workspaceId,
                branchName,
              },
            },
            create: { workspaceId: input.workspaceId, branchName },
            update: {},
          }),
        ),
      ]);

      return { ok: true as const };
    }),

  getBranchState: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      const workspace = await ctx.db.workspace.findUnique({
        where: { id: input.workspaceId },
        include: { activeBranches: true },
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      return {
        domainBranchName: workspace.domainBranchName,
        activeBranches: workspace.activeBranches.map((b) => b.branchName),
      };
    }),

  // Team Sync presence: the daemon reports the CL a workspace synced to after
  // each successful pull so other clients can show "N users synced here".
  updateSyncStatus: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        changelistNumber: z.number().nullable(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      await ctx.db.workspace.update({
        where: { id: input.workspaceId },
        data: {
          syncedChangelistNumber: input.changelistNumber,
          syncedAt: new Date(),
        },
      });

      return { ok: true as const };
    }),
});
