import { publicProcedure, router } from "../../trpc.js";
import {
  CreateApiClientAuth,
  type TeamSyncConfigResult,
  type TeamSyncChangelistMetaResult,
} from "@checkpointvcs/common";
import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  getWorkspaceConfig,
  getWorkspaceState,
  saveWorkspaceConfig,
  type Workspace as UtilWorkspace,
  type WorkspaceTeamSyncSettings,
} from "../../../util/util.js";
import { getProjectInfo } from "../../../util/unreal/index.js";
import { compileFilter } from "../../../util/team-sync/filter.js";
import { previewClean, executeClean } from "../../../util/team-sync/clean.js";
import {
  getBisectState,
  setBisectVerdict,
  resetBisect,
  computeBisectNext,
} from "../../../util/team-sync/bisect.js";
import { runBuild } from "../../../util/build/executor.js";
import { runGenerateProjectFiles } from "../../../util/build/generate-project-files.js";
import { JobManager } from "../../../job-manager.js";
import type { DaemonManager } from "../../../daemon-manager.js";
import type { Workspace } from "../../../types/workspace.js";

// Load the on-disk util Workspace (carries teamSync settings) for a resolved
// manager workspace, synthesizing a minimal one when workspace.json is absent.
async function loadUtilWorkspace(workspace: Workspace): Promise<UtilWorkspace> {
  return (
    (await getWorkspaceConfig(workspace.localPath)) ??
    ({
      id: workspace.id,
      repoId: workspace.repoId,
      branchName: workspace.branchName,
      workspaceName: workspace.name,
      localPath: workspace.localPath,
      daemonId: workspace.daemonId,
    } satisfies UtilWorkspace)
  );
}

// Resolve a workspace by daemon + workspace id or throw a NOT_FOUND error.
function resolveWorkspace(
  manager: DaemonManager,
  daemonId: string,
  workspaceId: string,
): Workspace {
  const workspaces = manager.workspaces.get(daemonId);
  if (!workspaces) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Could not find any workspaces locally for daemon ID ${daemonId}`,
    });
  }

  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Could not find workspace ID ${workspaceId}`,
    });
  }

  return workspace;
}

const settingsInput = z.object({
  categoryOverrides: z.record(z.string(), z.boolean()).optional(),
  customIncludeRules: z.array(z.string()).optional(),
  customExcludeRules: z.array(z.string()).optional(),
  preset: z.string().nullable().optional(),
  usePrecompiledBinaries: z.boolean().optional(),
  artifactTypes: z.array(z.string()).optional(),
  selectedProject: z.string().optional(),
  editorConfiguration: z.string().optional(),
  writeVersionFiles: z.boolean().optional(),
  afterSync: z
    .object({
      build: z.boolean().optional(),
      generateProjectFiles: z.boolean().optional(),
      runEditor: z.boolean().optional(),
      openSolution: z.boolean().optional(),
    })
    .optional(),
  scheduledSync: z
    .object({
      enabled: z.boolean(),
      timeOfDay: z.string(),
      target: z.enum(["latest", "latest-good", "latest-starred"]),
    })
    .optional(),
  // Step id -> enable override for repo-config and default build steps.
  buildStepOverrides: z
    .record(z.string(), z.object({ enabled: z.boolean().optional() }))
    .optional(),
  // User-defined build steps merged after the repo config steps.
  customBuildSteps: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z
          .enum(["command", "unreal-compile", "unreal-cook"])
          .default("command"),
        target: z.string().optional(),
        platform: z.string().optional(),
        configuration: z.string().optional(),
        arguments: z.string().optional(),
        command: z.string().optional(),
        workingDir: z.string().optional(),
        requires: z.array(z.string()).default([]),
        normalSync: z.boolean().default(false),
        scheduledSync: z.boolean().default(false),
        estimatedDurationSec: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

export const teamSyncRouter = router({
  // Resolved repo-committed Team Sync config at the workspace's current or
  // head changelist, proxied from the app server (parses + validates once).
  getConfig: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<TeamSyncConfigResult> => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      const client = await CreateApiClientAuth(input.daemonId);
      return client.teamSync.getConfig.query({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
      });
    }),

  // Per-changelist metadata (badges, review summaries, presence, artifact
  // types, code/content flags) for a page of changelists, proxied from the
  // app server. Returns {} when the org is not licensed for Team Sync.
  getChangelistMeta: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumbers: z.array(z.number()).min(1).max(250),
      }),
    )
    .query(async ({ ctx, input }): Promise<TeamSyncChangelistMetaResult> => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      const client = await CreateApiClientAuth(input.daemonId);
      try {
        return await client.teamSync.getChangelistMeta.query({
          repoId: workspace.repoId,
          changelistNumbers: input.changelistNumbers,
        });
      } catch {
        // Unlicensed or transient error: degrade to no metadata.
        return {};
      }
    }),

  // ── Review/vote proxies (write per-changelist metadata) ──────────

  setVote: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
        vote: z
          .enum(["COMPILE_SUCCESS", "COMPILE_FAILURE", "GOOD", "BAD"])
          .nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const client = await CreateApiClientAuth(input.daemonId);
      return client.changelistReview.setVote.mutate({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
        vote: input.vote,
      });
    }),

  setStarred: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
        starred: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const client = await CreateApiClientAuth(input.daemonId);
      return client.changelistReview.setStarred.mutate({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
        starred: input.starred,
      });
    }),

  setInvestigating: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
        investigating: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const client = await CreateApiClientAuth(input.daemonId);
      return client.changelistReview.setInvestigating.mutate({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
        investigating: input.investigating,
      });
    }),

  addComment: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
        body: z.string().min(1).max(4000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const client = await CreateApiClientAuth(input.daemonId);
      return client.changelistReview.addComment.mutate({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
        body: input.body,
      });
    }),

  listComments: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const client = await CreateApiClientAuth(input.daemonId);
      return client.changelistReview.listComments.query({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
      });
    }),

  // Resolve the newest changelist at or before the branch head whose required
  // badges are all green ("Sync Latest Good"). Returns null when none qualify
  // or when the repo config defines no required badges for any artifact type.
  findLatestGood: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(
      async ({ ctx, input }): Promise<{ changelistNumber: number } | null> => {
        const workspace = resolveWorkspace(
          ctx.manager,
          input.daemonId,
          input.workspaceId,
        );
        const client = await CreateApiClientAuth(input.daemonId);

        const branch = await client.branch.getBranch.query({
          repoId: workspace.repoId,
          name: workspace.branchName,
        });
        if (!branch) return null;

        // Required badges come from the repo config's artifact channels.
        const config = await client.teamSync.getConfig
          .query({
            repoId: workspace.repoId,
            changelistNumber: branch.headNumber,
          })
          .catch(() => null);
        const requiredBadges = [
          ...new Set(
            (config?.config?.artifacts ?? []).flatMap(
              (channel) => channel.requiredBadges,
            ),
          ),
        ];
        if (requiredBadges.length === 0) return null;

        return client.buildBadge.findLatestGood.query({
          repoId: workspace.repoId,
          startNumber: branch.headNumber,
          requiredBadges,
        });
      },
    ),

  // Per-workspace Team Sync settings stored in workspace.json.
  getSettings: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const config = await getWorkspaceConfig(workspace.localPath);
      return config?.teamSync ?? {};
    }),

  updateSettings: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        settings: settingsInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      const persisted = await getWorkspaceConfig(workspace.localPath);
      if (!persisted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace config missing on disk for ${workspace.id}`,
        });
      }

      const base: WorkspaceTeamSyncSettings = persisted.teamSync ?? {};
      const merged: WorkspaceTeamSyncSettings = {
        ...base,
        ...input.settings,
        afterSync: input.settings.afterSync
          ? { ...base.afterSync, ...input.settings.afterSync }
          : base.afterSync,
      };

      persisted.teamSync = merged;
      await saveWorkspaceConfig(persisted);

      return merged;
    }),

  // Preview which currently-synced files a proposed filter change would remove
  // (UGS's destructive-filter warning). Does not touch disk.
  previewFilterChange: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        settings: settingsInput,
      }),
    )
    .query(async ({ ctx, input }): Promise<{ toDelete: string[] }> => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      const client = await CreateApiClientAuth(input.daemonId);
      const persisted = await getWorkspaceConfig(workspace.localPath);
      const base: WorkspaceTeamSyncSettings = persisted?.teamSync ?? {};
      const proposed: WorkspaceTeamSyncSettings = {
        ...base,
        ...input.settings,
      };

      const state = await getWorkspaceState(workspace.localPath);
      const configResult = await client.teamSync.getConfig
        .query({
          repoId: workspace.repoId,
          changelistNumber: state.changelistNumber,
        })
        .catch(() => null);

      const filter = compileFilter(configResult?.config ?? null, proposed);
      if (filter.isNoOp) return { toDelete: [] };

      const toDelete = Object.keys(state.files).filter(
        (relPath) => !filter.matches(relPath),
      );
      return { toDelete };
    }),

  // .uproject path(s), engine location, editor target for this workspace.
  getProjectInfo: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      // Load the on-disk workspace config (carries teamSync.selectedProject);
      // fall back to a synthesized config if it is missing.
      const config =
        (await getWorkspaceConfig(workspace.localPath)) ??
        ({
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        } satisfies UtilWorkspace);

      const state = await getWorkspaceState(workspace.localPath);
      return getProjectInfo(config, state);
    }),

  // Run the workspace's build steps (compile the editor, etc.) after a sync.
  // Fire-and-forget: returns a job id immediately; progress is on the job.
  build: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        forceClean: z.boolean().optional(),
        scheduled: z.boolean().optional(),
        stepIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      // Load the on-disk workspace config (carries teamSync build settings);
      // synthesize a minimal config if it is missing, matching getProjectInfo.
      const utilWorkspace =
        (await getWorkspaceConfig(workspace.localPath)) ??
        ({
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        } satisfies UtilWorkspace);

      const manager = ctx.manager;
      const jobManager = JobManager.Get();
      const job = jobManager.createJob("build", workspace.id);

      // Fire-and-forget: run the build in the background.
      (async () => {
        manager.beginVcsOperation(workspace.id);
        try {
          const client = await CreateApiClientAuth(input.daemonId);
          const orgId = await client.repo.getRepo
            .query({ id: workspace.repoId })
            .then((repo) => repo?.orgId ?? "")
            .catch(() => "");

          const result = await runBuild(utilWorkspace, orgId, job.id, {
            forceClean: input.forceClean,
            scheduled: input.scheduled,
            stepIds: input.stepIds,
          });

          if (result.success) {
            jobManager.completeJob(job.id, result);
          } else {
            jobManager.failJob(
              job.id,
              "Build failed; see the job logs for details.",
            );
          }
        } catch (e: any) {
          jobManager.failJob(job.id, e?.message ?? String(e));
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      })();

      return { jobId: job.id };
    }),

  // Generate IDE project files for the workspace. Fire-and-forget like build.
  generateProjectFiles: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      const utilWorkspace =
        (await getWorkspaceConfig(workspace.localPath)) ??
        ({
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        } satisfies UtilWorkspace);

      const manager = ctx.manager;
      const jobManager = JobManager.Get();
      const job = jobManager.createJob("generate-project-files", workspace.id);

      // Fire-and-forget: run the generation in the background.
      (async () => {
        manager.beginVcsOperation(workspace.id);
        try {
          const client = await CreateApiClientAuth(input.daemonId);
          const orgId = await client.repo.getRepo
            .query({ id: workspace.repoId })
            .then((repo) => repo?.orgId ?? "")
            .catch(() => "");

          await runGenerateProjectFiles(utilWorkspace, orgId, job.id);
          jobManager.completeJob(job.id, { success: true });
        } catch (e: any) {
          jobManager.failJob(job.id, e?.message ?? String(e));
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      })();

      return { jobId: job.id };
    }),

  // ── Clean workspace ──────────────────────────────────────────────

  cleanPreview: publicProcedure
    .input(z.object({ daemonId: z.string(), workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const utilWorkspace = await loadUtilWorkspace(workspace);
      return previewClean(utilWorkspace);
    }),

  cleanExecute: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        paths: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const utilWorkspace = await loadUtilWorkspace(workspace);

      ctx.manager.beginVcsOperation(workspace.id);
      try {
        return await executeClean(utilWorkspace, input.paths);
      } finally {
        await ctx.manager.endVcsOperation(workspace.id);
      }
    }),

  // ── Bisect ───────────────────────────────────────────────────────

  bisectGetState: publicProcedure
    .input(z.object({ daemonId: z.string(), workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const utilWorkspace = await loadUtilWorkspace(workspace);
      const bisect = await getBisectState(utilWorkspace);

      // Resolve the branch history so we can compute the next CL to test.
      const client = await CreateApiClientAuth(input.daemonId);
      const changelists = await client.changelist.getChangelists
        .query({
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          start: { number: null, timestamp: null },
          count: 250,
        })
        .catch(() => []);
      const historyNumbers = changelists.map((cl) => cl.number);

      return { bisect, next: computeBisectNext(bisect, historyNumbers) };
    }),

  bisectMark: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
        verdict: z.enum(["pass", "fail", "include", "exclude"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const utilWorkspace = await loadUtilWorkspace(workspace);
      await setBisectVerdict(
        utilWorkspace,
        input.changelistNumber,
        input.verdict,
      );
      return { ok: true };
    }),

  bisectReset: publicProcedure
    .input(z.object({ daemonId: z.string(), workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const utilWorkspace = await loadUtilWorkspace(workspace);
      await resetBisect(utilWorkspace);
      return { ok: true };
    }),
});
