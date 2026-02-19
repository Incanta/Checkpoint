import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { DaemonManager } from "../../../daemon-manager.js";
import {
  checkConflicts,
  getWorkspaceState,
  saveWorkspaceState,
  getWorkspaceConfig,
  saveWorkspaceConfig,
  type Workspace as UtilWorkspace,
} from "../../../util/index.js";
import { TRPCError } from "@trpc/server";

export const conflictsRouter = router({
  check: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      // Get pending changes for locally modified paths
      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      const locallyModifiedPaths = pendingChanges
        ? Object.keys(pendingChanges.files)
        : [];

      return await checkConflicts(
        {
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        },
        locallyModifiedPaths,
      );
    }),

  resolve: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        filePaths: z.array(z.string()),
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

      // Get current sync status to know the remote head CL for each file
      let syncStatus = manager.getSyncStatus(workspace.id);
      if (!syncStatus) {
        syncStatus = await manager.refreshSyncStatus(workspace);
      }

      // Verify the remote head hasn't moved in a way that affects the files
      // being resolved. This prevents silently resolving against stale conflict
      // data when another user pushed changes to the SAME files in the meantime.
      // If the head moved but only touched unrelated files, we allow the resolve.
      const config = await getWorkspaceConfig(workspace.localPath);
      if (config?.lastSyncStatusRemoteHead != null) {
        const client = await CreateApiClientAuth(workspace.daemonId);
        const branch = await client.branch.getBranch.query({
          repoId: workspace.repoId,
          name: workspace.branchName,
        });

        if (branch && branch.headNumber !== config.lastSyncStatusRemoteHead) {
          // Head moved — walk the parent chain from headNumber back to
          // lastSyncStatusRemoteHead and check if any of the requested
          // files were modified in those intervening changelists.
          const normalizedResolvePaths = new Set(
            input.filePaths.map((p) =>
              p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
            ),
          );

          const { paths: changedPaths } =
            (await client.changelist.getFilePathsChangedBetween.query({
              repoId: workspace.repoId,
              fromNumber: config.lastSyncStatusRemoteHead,
              toNumber: branch.headNumber,
            })) as { paths: string[] };

          const affectedPaths = changedPaths
            .map((p: string) => p.replace(/^[/\\]/, "").replace(/\\/g, "/"))
            .filter((p: string) => normalizedResolvePaths.has(p));

          if (affectedPaths.length > 0) {
            const affectedList = affectedPaths.join(", ");
            throw new TRPCError({
              code: "CONFLICT",
              message:
                `The remote branch head has moved from CL ${config.lastSyncStatusRemoteHead} ` +
                `to CL ${branch.headNumber} since the last sync status check, ` +
                `and the following files you are trying to resolve were modified ` +
                `in the new changelist(s): ${affectedList}. ` +
                `Please refresh sync status before resolving these conflicts.`,
            });
          }
        }
      }

      // Get the current workspace state
      const state = await getWorkspaceState(workspace.localPath);

      // Build a lookup from the outdated files
      const outdatedByPath = new Map(
        syncStatus.outdatedFiles.map((f) => [
          f.path.replace(/^[\/\\]/, "").replace(/\\/g, "/"),
          f,
        ]),
      );

      const resolvedPaths: string[] = [];

      for (const filePath of input.filePaths) {
        const normalizedPath = filePath
          .replace(/^[\/\\]/, "")
          .replace(/\\/g, "/");

        const outdated = outdatedByPath.get(normalizedPath);
        if (outdated && state.files[normalizedPath]) {
          // Update the file's CL to match the remote, marking it as resolved
          state.files[normalizedPath]!.changelist = outdated.remoteChangelist;
          resolvedPaths.push(normalizedPath);
        }
      }

      if (resolvedPaths.length > 0) {
        // Persist the updated state
        const utilWorkspace: UtilWorkspace = {
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        };
        await saveWorkspaceState(utilWorkspace, state);

        // Reload cached state in the daemon manager
        await manager.reloadWorkspaceState(workspace);

        // Refresh sync status since conflicts may have changed
        await manager.refreshSyncStatus(workspace);
      }

      return { resolvedPaths };
    }),

  getResolveConfirmSuppressed: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) return { suppressed: false };

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) return { suppressed: false };

      const config = await getWorkspaceConfig(workspace.localPath);
      if (!config?.suppressResolveConfirmUntil) return { suppressed: false };

      const value = config.suppressResolveConfirmUntil;

      // "workspace" means permanently suppressed for this workspace
      if (value === "workspace") return { suppressed: true };

      // Otherwise it's an ISO date string — check if we're still within the day
      const suppressDate = new Date(value);
      const now = new Date();
      if (
        suppressDate.getFullYear() === now.getFullYear() &&
        suppressDate.getMonth() === now.getMonth() &&
        suppressDate.getDate() === now.getDate()
      ) {
        return { suppressed: true };
      }

      // Expired — clear it
      if (config) {
        config.suppressResolveConfirmUntil = null;
        await saveWorkspaceConfig(config);
      }
      return { suppressed: false };
    }),

  setResolveConfirmSuppressed: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        /** "today" or "workspace" */
        duration: z.enum(["today", "workspace"]),
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

      const config = await getWorkspaceConfig(workspace.localPath);
      const workspaceConfig: UtilWorkspace = config ?? {
        id: workspace.id,
        repoId: workspace.repoId,
        branchName: workspace.branchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };

      if (input.duration === "workspace") {
        workspaceConfig.suppressResolveConfirmUntil = "workspace";
      } else {
        // "today" — store today's date in ISO format
        workspaceConfig.suppressResolveConfirmUntil = new Date().toISOString();
      }

      await saveWorkspaceConfig(workspaceConfig);
      return { success: true };
    }),
});
