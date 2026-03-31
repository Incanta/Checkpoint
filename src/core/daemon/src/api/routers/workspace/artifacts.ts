import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { submit } from "../../../util/submit.js";
import { JobManager } from "../../../job-manager.js";
import { saveWorkspaceConfig } from "../../../util/util.js";

export const artifactsRouter = router({
  // Upload artifacts for an existing changelist
  upload: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
        modifications: z.array(
          z.object({
            delete: z.boolean(),
            path: z.string(),
            oldPath: z.string().optional(),
          }),
        ),
        message: z.string().default("Artifact upload"),
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
      const repo = await client.repo.getRepo.query({ id: workspace.repoId });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find repo for workspace ID ${input.workspaceId}`,
        });
      }

      // Expand directory paths into individual file modifications
      const expandedModifications = await manager.expandDirectoriesForSubmit(
        workspace,
        input.modifications,
      );

      const jobManager = JobManager.Get();
      const job = jobManager.createJob("artifact-upload");

      const workspaceInfo = {
        id: workspace.id,
        repoId: workspace.repoId,
        branchName: workspace.branchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };

      // Fire-and-forget: run the artifact upload in the background
      (async () => {
        manager.beginVcsOperation(workspace.id);
        try {
          await submit(
            workspaceInfo,
            repo.orgId,
            input.message,
            expandedModifications,
            workspace.id,
            false, // keepCheckedOut
            undefined,
            (step) => jobManager.updateStep(job.id, step),
            (step, done, total) =>
              jobManager.updateProgress(job.id, done, total),
            undefined, // shelfName
            input.changelistNumber, // artifactForChangelistNum
          );

          jobManager.completeJob(job.id);
        } catch (e: any) {
          jobManager.failJob(job.id, e.message ?? String(e));
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      })();

      return { jobId: job.id };
    }),

  // List artifacts for a changelist (proxy to app API)
  list: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
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
      return client.artifact.list.query({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
      });
    }),

  // Toggle includeArtifacts preference for a workspace
  setPreference: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        includeArtifacts: z.boolean(),
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

      workspace.includeArtifacts = input.includeArtifacts;
      await saveWorkspaceConfig(workspace);

      return { includeArtifacts: workspace.includeArtifacts };
    }),
});
