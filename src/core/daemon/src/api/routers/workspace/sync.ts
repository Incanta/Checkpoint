import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";

import { pull, checkConflicts } from "../../../util/index.js";
import { TRPCError } from "@trpc/server";
import { ApiTypes } from "../../../types/api-types.js";
import { Logger } from "../../../logging.js";
import { JobManager } from "../../../job-manager.js";

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
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
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

      Logger.info(
        `Initiating pull for workspace ${workspace.name} (CL ${input.changelistId ?? "latest"}) with file filter: ${
          input.filePaths ? input.filePaths.join(", ") : "none"
        }`,
      );

      // Check for conflicts before pulling (sync — fail fast)
      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      if (pendingChanges && pendingChanges.numChanges > 0) {
        Logger.debug(
          `Workspace ${workspace.name} has ${pendingChanges.numChanges} pending changes. Checking for conflicts before pull...`,
        );
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
          Logger.debug(
            `Workspace ${workspace.name} has ${conflictResult.conflicts.length} conflicting file(s) detected: ${conflictResult.conflicts
              .map((c) => c.path)
              .join(", ")}`,
          );

          const conflictPaths = conflictResult.conflicts
            .map((c) => c.path)
            .join(", ");
          throw new TRPCError({
            code: "CONFLICT",
            message: `Cannot pull: ${conflictResult.conflicts.length} conflicting file(s) detected. These files have been modified locally and also changed on the remote: ${conflictPaths}`,
          });
        }
      }

      Logger.debug(
        `No conflicts detected for workspace ${workspace.name}. Proceeding with pull...`,
      );

      // Create async job for the long-running work
      const jobManager = JobManager.Get();
      const job = jobManager.createJob("pull");

      const workspaceInfo = {
        id: workspace.id,
        repoId: workspace.repoId,
        branchName: workspace.branchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };

      // Fire-and-forget: run the pull in the background
      (async () => {
        manager.beginVcsOperation(workspace.id);
        try {
          const mergeResult = await pull(
            workspaceInfo,
            repo.orgId,
            input.changelistId,
            input.filePaths,
            undefined,
            (step) => jobManager.updateStep(job.id, step),
            (step, done, total) =>
              jobManager.updateProgress(job.id, done, total),
          );

          Logger.debug(
            `Pull completed for workspace ${workspace.name}. Merge result: ${mergeResult.conflictMerges.length === 0 ? "success" : "failure"}. Conflicts: ${
              mergeResult.conflictMerges.length
            }.`,
          );

          jobManager.updateStep(job.id, "Reloading workspace state");
          await manager.reloadWorkspaceState(workspace);
          manager.clearSyncStatus(workspace.id);

          jobManager.completeJob(job.id, mergeResult);
        } catch (e: any) {
          Logger.error(
            `Pull failed for workspace ${workspace.name}: ${e.message}`,
          );
          jobManager.failJob(job.id, e.message ?? String(e));
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      })();

      return { jobId: job.id };
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
      const manager = ctx.manager;
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
      const manager = ctx.manager;
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
        await client.changelist.getChangelistsWithNumbers.mutate({
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
