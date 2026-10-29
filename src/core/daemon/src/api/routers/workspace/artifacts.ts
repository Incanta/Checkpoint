import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { submit } from "../../../util/submit.js";
import { JobManager } from "../../../job-manager.js";
import * as addon from "@checkpointvcs/longtail-addon";
import {
  artifactRulesFor,
  collectArtifactFiles,
  expandArtifactPaths,
} from "../../../util/artifact-files.js";

/** Whether the installed native addon sends an artifact upload's type. */
function addonSupportsArtifactTypes(): boolean {
  return (
    (addon as unknown as { SUPPORTS_ARTIFACT_TYPES?: boolean })
      .SUPPORTS_ARTIFACT_TYPES === true
  );
}

export const artifactsRouter = router({
  /**
   * Uploads artifacts (build outputs) of `type` for an existing changelist.
   * With no files named, collects the files the repo config's rules for the
   * type select and replaces that set. Named files and folders are added to
   * the set unless `replace` is set. `.chkignore` never applies: build
   * outputs are what it ignores.
   */
  upload: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
        modifications: z
          .array(
            z.object({
              delete: z.boolean(),
              path: z.string(),
              oldPath: z.string().optional(),
            }),
          )
          .default([]),
        type: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9_-]+$/),
        replace: z.boolean().optional(),
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

      const named = input.modifications
        .filter((m) => !m.delete)
        .map((m) => m.path);
      const collect = named.length === 0;
      const replace = input.replace ?? collect;
      if (!addonSupportsArtifactTypes()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This daemon's native addon is too old to upload artifacts, since it cannot name their type. Update Checkpoint.",
        });
      }

      // The rules for this type in the repo config at the changelist the
      // artifacts are for.
      const configResult = await client.teamSync.getConfig
        .query({
          repoId: workspace.repoId,
          changelistNumber: input.changelistNumber,
        })
        .catch(() => null);
      const rules = artifactRulesFor(
        configResult?.config?.artifacts,
        input.type,
      );
      if (collect && !rules?.include.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No files named, and teamsync.yaml at changelist ${input.changelistNumber} has no include patterns for artifact type "${input.type}". Add them under artifacts, or name the files to upload.`,
        });
      }

      const jobManager = JobManager.Get();
      const job = jobManager.createJob("artifact-upload");

      const workspaceInfo = {
        id: workspace.id,
        repoId: workspace.repoId,
        domainBranchName: workspace.domainBranchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };

      // Fire-and-forget: run the artifact upload in the background
      (async () => {
        manager.beginVcsOperation(workspace.id);
        try {
          jobManager.updateStep(job.id, "Collecting files");
          const owned = manager.getIgnoreCache(workspace.id).owned;
          const files = collect
            ? await collectArtifactFiles(workspace.localPath, rules!, owned)
            : await expandArtifactPaths(
                workspace.localPath,
                named,
                rules?.exclude ?? [],
                owned,
              );
          if (files.length === 0) {
            throw new Error(
              collect
                ? `No files match the include patterns for artifact type "${input.type}"`
                : "No files to upload",
            );
          }

          await submit(
            workspaceInfo,
            repo.orgId,
            input.message,
            files.map((path) => ({ delete: false, path })),
            workspace.id,
            false, // keepCheckedOut
            undefined,
            (step) => jobManager.updateStep(job.id, step),
            (step, done, total) =>
              jobManager.updateProgress(job.id, done, total),
            input.changelistNumber, // artifactForChangelistNum
            undefined,
            { type: input.type, replace },
          );

          // A server from before artifact types attaches elsewhere and never
          // replaces; say so rather than report success.
          const sets = await client.artifact.listSets.query({
            repoId: workspace.repoId,
            changelistNumber: input.changelistNumber,
          });
          const set = sets.find((s) => s.type === input.type);
          if (!set) {
            throw new Error(
              `Uploaded, but the server did not attach the files to the "${input.type}" set; it is too old for artifact types. Update the server.`,
            );
          }
          if (replace && set.fileCount !== files.length) {
            throw new Error(
              `Uploaded, but the "${input.type}" set at changelist ${input.changelistNumber} has ${set.fileCount} files rather than the ${files.length} uploaded; the server is too old to replace a set. Update the server.`,
            );
          }

          jobManager.completeJob(job.id, {
            type: input.type,
            fileCount: files.length,
            replaced: replace,
          });
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
});
