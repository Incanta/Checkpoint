import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";

import { FileStatus } from "../../../types/index.js";
import { DaemonConfig } from "../../../daemon-config.js";
import {
  getBinaryExtensions,
  isBinaryFile,
  pull,
  getWorkspaceConfig,
  saveWorkspaceConfig,
  type Workspace as UtilWorkspace,
} from "../../../util/index.js";
import { TRPCError } from "@trpc/server";

/**
 * Walks a feature branch up to its domain root, returning the chain in
 * ancestor-first order.
 *
 * Overlays are applied in this order, and a stacked branch is meaningless
 * without the branches beneath it, so activation always takes the whole chain
 * rather than a single name.
 */
async function resolveBranchChain(
  client: Awaited<ReturnType<typeof CreateApiClientAuth>>,
  repoId: string,
  branchName: string,
): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = branchName;

  for (let hops = 0; hops < 64 && current; hops++) {
    const branch = await client.branch.getBranch.query({
      repoId,
      name: current,
    });

    if (!branch || branch.isClaimDomainRoot) {
      break;
    }

    chain.unshift(branch.name);
    current = branch.parentBranchName;
  }

  return chain;
}

export const branchesRouter = router({
  list: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        includeArchived: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      const branches = await client.branch.listBranches.query({
        repoId: workspace.repoId,
        includeArchived: input.includeArchived,
      });

      return { branches, currentBranchName: workspace.domainBranchName };
    }),

  create: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        name: z.string().min(1),
        headNumber: z.number(),
        type: z.enum(["MAINLINE", "RELEASE", "FEATURE"]).default("FEATURE"),
        parentBranchName: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      const branch = await client.branch.createBranch.mutate({
        repoId: workspace.repoId,
        name: input.name,
        headNumber: input.headNumber,
        type: input.type,
        parentBranchName: input.parentBranchName,
      });

      return branch;
    }),

  switch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);

      // Get the target branch
      const targetBranch = await client.branch.getBranch.query({
        repoId: workspace.repoId,
        name: input.branchName,
      });

      if (!targetBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch "${input.branchName}" not found`,
        });
      }

      if (targetBranch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot switch to an archived branch",
        });
      }

      // Check for conflicts: get pending changes
      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      if (pendingChanges && pendingChanges.numChanges > 0) {
        // Check if any binary files have been modified
        const locallyModifiedPaths = Object.entries(pendingChanges.files)
          .filter(([_, file]) => {
            const status = file.status;
            return (
              status === FileStatus.Added ||
              status === FileStatus.Renamed ||
              status === FileStatus.Deleted ||
              status === FileStatus.ChangedCheckedOut ||
              status === FileStatus.ChangedNotCheckedOut
            );
          })
          .map(([path]) => path);

        if (locallyModifiedPaths.length > 0) {
          // Get all files changed between the current and target branch heads
          const currentBranch = await client.branch.getBranch.query({
            repoId: workspace.repoId,
            name: workspace.domainBranchName,
          });

          if (currentBranch) {
            // Check for binary file conflicts
            const { paths: remoteChangedPaths } =
              (await client.changelist.getFilePathsChangedBetween.query({
                repoId: workspace.repoId,
                fromNumber: Math.min(
                  currentBranch.headNumber,
                  targetBranch.headNumber,
                ),
                toNumber: Math.max(
                  currentBranch.headNumber,
                  targetBranch.headNumber,
                ),
              })) as { paths: string[] };

            const conflictingPaths = locallyModifiedPaths.filter((p) =>
              remoteChangedPaths.includes(p),
            );

            if (conflictingPaths.length > 0) {
              // Check for binary files in conflicts
              const binaryExts = await getBinaryExtensions(
                input.daemonId,
                workspace.repoId,
              );
              const binaryConflicts = conflictingPaths.filter((p) =>
                isBinaryFile(p, binaryExts),
              );

              if (binaryConflicts.length > 0) {
                throw new TRPCError({
                  code: "CONFLICT",
                  message: `Cannot switch branches: the following binary files have local changes that conflict: ${binaryConflicts.join(", ")}`,
                });
              }
            }
          }
        }
      }

      // A workspace materializes from a domain root and overlays feature
      // branches on top, so "switch" means two different operations depending
      // on what you point it at.
      //
      // Switching domains re-pulls the whole tree, and the server refuses it
      // outright when this workspace still holds claims in the old domain:
      // claims are anchored to the domain they were taken in and cannot follow.
      //
      // Activating a feature branch is not a re-pull at all. It adds the branch
      // to the overlay and pulls only its delta, which is the entire reason
      // multi-branch workspaces are worth having.
      const activatingOverlay = !targetBranch.isClaimDomainRoot;

      const domainBranchName = activatingOverlay
        ? (targetBranch.domainBranchName ?? workspace.domainBranchName)
        : input.branchName;

      // A stacked branch expresses its changes relative to its parent, so it
      // cannot be overlaid alone: activating it activates its whole chain.
      const activeBranches = activatingOverlay
        ? await resolveBranchChain(client, workspace.repoId, input.branchName)
        : [];

      if (
        activatingOverlay &&
        domainBranchName !== workspace.domainBranchName
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${input.branchName}" belongs to the "${domainBranchName}" domain. Switch this workspace to "${domainBranchName}" before activating it.`,
        });
      }

      // The server owns the decision: it rejects a cross-domain move that
      // would strand claims, and validates that the chain is complete.
      await client.workspace.setBranchState.mutate({
        workspaceId: workspace.id,
        domainBranchName,
        activeBranches,
      });

      workspace.domainBranchName = domainBranchName;
      workspace.activeBranches = activeBranches;

      // Update daemon config
      const daemonConfig = DaemonConfig.Ensure();
      const configWorkspace = daemonConfig.vars.workspaces.find(
        (w) => w.id === workspace.id,
      );
      if (configWorkspace) {
        configWorkspace.domainBranchName = domainBranchName;
        configWorkspace.activeBranches = activeBranches;
      }
      await DaemonConfig.Save();

      // Save workspace config to disk
      const workspaceConfig = await getWorkspaceConfig(workspace.localPath);
      const workspaceConfigToSave: UtilWorkspace = workspaceConfig ?? {
        id: workspace.id,
        repoId: workspace.repoId,
        domainBranchName,
        activeBranches,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };
      workspaceConfigToSave.domainBranchName = domainBranchName;
      workspaceConfigToSave.activeBranches = activeBranches;
      await saveWorkspaceConfig(workspaceConfigToSave);

      // Pull to the target head. For an overlay this is the feature branch's
      // head, which carries the domain root's content plus that branch's
      // changes; for a domain switch it is the new root's head.
      const repo = await client.repo.getRepo.query({ id: workspace.repoId });
      if (repo) {
        manager.beginVcsOperation(workspace.id);
        try {
          await pull(
            {
              id: workspace.id,
              repoId: workspace.repoId,
              domainBranchName: input.branchName,
              activeBranches,
              workspaceName: workspace.name,
              localPath: workspace.localPath,
              daemonId: workspace.daemonId,
            },
            repo.orgId,
            null,
            null,
          );
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      }

      // Reload workspace state
      await manager.reloadWorkspaceState(workspace);
      manager.clearSyncStatus(workspace.id);

      return {
        success: true,
        branchName: input.branchName,
        domainBranchName,
        activeBranches,
      };
    }),

  /**
   * Removes a feature branch from the workspace's overlay and re-pulls to
   * whatever remains. Anything stacked on it comes off too, since a stacked
   * branch cannot stand without its parent.
   */
  deactivate: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      const workspace = workspaces?.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const remaining: string[] = [];
      for (const name of workspace.activeBranches) {
        if (name === input.branchName) {
          continue;
        }
        const chain = await resolveBranchChain(client, workspace.repoId, name);
        if (chain.includes(input.branchName)) {
          continue;
        }
        remaining.push(name);
      }

      await client.workspace.setBranchState.mutate({
        workspaceId: workspace.id,
        domainBranchName: workspace.domainBranchName,
        activeBranches: remaining,
      });

      workspace.activeBranches = remaining;

      const daemonConfig = DaemonConfig.Ensure();
      const configWorkspace = daemonConfig.vars.workspaces.find(
        (w) => w.id === workspace.id,
      );
      if (configWorkspace) {
        configWorkspace.activeBranches = remaining;
      }
      await DaemonConfig.Save();

      const workspaceConfig = await getWorkspaceConfig(workspace.localPath);
      if (workspaceConfig) {
        workspaceConfig.activeBranches = remaining;
        await saveWorkspaceConfig(workspaceConfig);
      }

      const repo = await client.repo.getRepo.query({ id: workspace.repoId });
      if (repo) {
        manager.beginVcsOperation(workspace.id);
        try {
          await pull(
            {
              id: workspace.id,
              repoId: workspace.repoId,
              domainBranchName:
                remaining[remaining.length - 1] ?? workspace.domainBranchName,
              activeBranches: remaining,
              workspaceName: workspace.name,
              localPath: workspace.localPath,
              daemonId: workspace.daemonId,
            },
            repo.orgId,
            null,
            null,
          );
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      }

      await manager.reloadWorkspaceState(workspace);
      manager.clearSyncStatus(workspace.id);

      return { success: true, activeBranches: remaining };
    }),

  archive: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);

      // return client.branch.archiveBranch.mutate({
      //   repoId: workspace.repoId,
      //   branchName: input.branchName,
      // });
    }),

  unarchive: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);

      // return client.branch.unarchiveBranch.mutate({
      //   repoId: workspace.repoId,
      //   branchName: input.branchName,
      // });
    }),

  delete: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);

      return await client.branch.deleteBranch.mutate({
        repoId: workspace.repoId,
        branchName: input.branchName,
      });
    }),

  merge: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        incomingBranchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const result = await client.branch.mergeBranch.mutate({
        repoId: workspace.repoId,
        incomingBranchName: input.incomingBranchName,
        targetBranchName: workspace.domainBranchName,
      });

      // Pull the merge CL into the workspace
      const repo = await client.repo.getRepo.query({ id: workspace.repoId });
      if (repo) {
        manager.beginVcsOperation(workspace.id);
        try {
          await pull(
            {
              id: workspace.id,
              repoId: workspace.repoId,
              domainBranchName: workspace.domainBranchName,
              workspaceName: workspace.name,
              localPath: workspace.localPath,
              daemonId: workspace.daemonId,
            },
            repo.orgId,
            null,
            null,
            "off",
          );
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      }

      // Reload workspace state
      await manager.reloadWorkspaceState(workspace);
      manager.clearSyncStatus(workspace.id);

      return result;
    }),
});
