import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { DaemonManager } from "../../../daemon-manager.js";
import { pull, checkConflicts } from "../../../util/index.js";
import { TRPCError } from "@trpc/server";
import { ApiTypes } from "../../../types/api-types.js";

export const syncRouter = router({
  pull: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistId: z.number().nullable(),
        filePaths: z.array(z.string()).nullable(),
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

      const client = await CreateApiClientAuth(input.daemonId);

      const repo = await client.repo.getRepo.query({ id: workspace.repoId });

      if (!repo) {
        throw new Error(
          `Could not find repo for workspace ID ${input.workspaceId}`,
        );
      }

      // Check for conflicts before pulling
      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      if (pendingChanges && pendingChanges.numChanges > 0) {
        const locallyModifiedPaths = Object.keys(pendingChanges.files);
        const conflictResult = await checkConflicts(
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

        if (conflictResult.hasConflicts) {
          const conflictPaths = conflictResult.conflicts
            .map((c) => c.path)
            .join(", ");
          throw new TRPCError({
            code: "CONFLICT",
            message: `Cannot pull: ${conflictResult.conflicts.length} conflicting file(s) detected. These files have been modified locally and also changed on the remote: ${conflictPaths}`,
          });
        }
      }

      const mergeResult = await pull(
        {
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        },
        repo.orgId,
        input.changelistId,
        input.filePaths,
      );

      // Reload workspace state from the updated state.json
      await manager.reloadWorkspaceState(workspace);

      // Clear cached sync status since we just pulled
      manager.clearSyncStatus(workspace.id);

      return mergeResult;
    }),

  getSyncStatus: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        forceRefresh: z.boolean().optional().default(false),
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

      // Return cached status unless force refresh
      if (!input.forceRefresh) {
        const cached = manager.getSyncStatus(workspace.id);
        if (cached) {
          return cached;
        }
      }

      return await manager.refreshSyncStatus(workspace);
    }),

  getSyncPreview: publicProcedure
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

      // Get fresh sync status
      const syncStatus = await manager.refreshSyncStatus(workspace);

      if (syncStatus.upToDate) {
        return {
          syncStatus,
          changelists: [],
          allFileChanges: [],
        };
      }

      // Fetch the changelist details for all CLs that need to be pulled
      const client = await CreateApiClientAuth(input.daemonId);

      const changelistsResponse =
        await client.changelist.getChangelistsWithNumbers.query({
          repoId: workspace.repoId,
          numbers: syncStatus.changelistsToPull,
        });

      const sortedChangelists = changelistsResponse.sort(
        (a: any, b: any) => a.number - b.number,
      );

      // Fetch file changes for each changelist
      const allFileChanges: Array<{
        changelistNumber: number;
        message: string;
        user: string;
        date: string;
        files: Array<{
          fileId: string;
          path: string;
          changeType: ApiTypes.FileChangeType;
          oldPath: string | null;
        }>;
      }> = [];

      for (const cl of sortedChangelists) {
        try {
          const files = await client.changelist.getChangelistFiles.query({
            repoId: workspace.repoId,
            changelistNumber: cl.number,
          });

          allFileChanges.push({
            changelistNumber: cl.number,
            message: cl.message ?? "",
            user: (cl as any).user?.email ?? "Unknown",
            date: new Date(cl.createdAt).toISOString(),
            files,
          });
        } catch {
          // Skip changelists we can't fetch files for
          allFileChanges.push({
            changelistNumber: cl.number,
            message: cl.message ?? "",
            user: (cl as any).user?.email ?? "Unknown",
            date: new Date(cl.createdAt).toISOString(),
            files: [],
          });
        }
      }

      return {
        syncStatus,
        changelists: sortedChangelists,
        allFileChanges,
      };
    }),
});
