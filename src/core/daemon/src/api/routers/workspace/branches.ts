import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { DaemonManager } from "../../../daemon-manager.js";
import { FileStatus } from "../../../types/index.js";
import { DaemonConfig } from "../../../daemon-config.js";
import {
  isBinaryFile,
  pull,
  getWorkspaceConfig,
  saveWorkspaceConfig,
  type Workspace as UtilWorkspace,
} from "../../../util/index.js";
import { TRPCError } from "@trpc/server";

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
      const manager = DaemonManager.Get();
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

      return { branches, currentBranchName: workspace.branchName };
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
      const manager = DaemonManager.Get();
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
      const manager = DaemonManager.Get();
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
            name: workspace.branchName,
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
              const binaryConflicts = conflictingPaths.filter((p) =>
                isBinaryFile(p),
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

      // Update the workspace branch name
      workspace.branchName = input.branchName;

      // Update daemon config
      const daemonConfig = DaemonConfig.Ensure();
      const configWorkspace = daemonConfig.vars.workspaces.find(
        (w) => w.id === workspace.id,
      );
      if (configWorkspace) {
        configWorkspace.branchName = input.branchName;
      }
      await DaemonConfig.Save();

      // Save workspace config to disk
      const config = await getWorkspaceConfig(workspace.localPath);
      const workspaceConfigToSave: UtilWorkspace = config ?? {
        id: workspace.id,
        repoId: workspace.repoId,
        branchName: input.branchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };
      workspaceConfigToSave.branchName = input.branchName;
      await saveWorkspaceConfig(workspaceConfigToSave);

      // Pull to the target branch head
      const repo = await client.repo.getRepo.query({ id: workspace.repoId });
      if (repo) {
        await pull(
          {
            id: workspace.id,
            repoId: workspace.repoId,
            branchName: input.branchName,
            workspaceName: workspace.name,
            localPath: workspace.localPath,
            daemonId: workspace.daemonId,
          },
          repo.orgId,
          null,
          null,
        );
      }

      // Reload workspace state
      await manager.reloadWorkspaceState(workspace);
      manager.clearSyncStatus(workspace.id);

      return { success: true, branchName: input.branchName };
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
      const manager = DaemonManager.Get();
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
      const manager = DaemonManager.Get();
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
      const manager = DaemonManager.Get();
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
      const manager = DaemonManager.Get();
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
        targetBranchName: workspace.branchName,
      });

      // Pull the merge CL into the workspace
      const repo = await client.repo.getRepo.query({ id: workspace.repoId });
      if (repo) {
        await pull(
          {
            id: workspace.id,
            repoId: workspace.repoId,
            branchName: workspace.branchName,
            workspaceName: workspace.name,
            localPath: workspace.localPath,
            daemonId: workspace.daemonId,
          },
          repo.orgId,
          null,
          null,
        );
      }

      // Reload workspace state
      await manager.reloadWorkspaceState(workspace);
      manager.clearSyncStatus(workspace.id);

      return result;
    }),
});
