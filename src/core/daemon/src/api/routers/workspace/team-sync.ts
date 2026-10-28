import { publicProcedure, router } from "../../trpc.js";
import {
  CreateApiClientAuth,
  type TeamSyncConfigResult,
  type TeamSyncChangelistMetaResult,
  type TeamSyncPinChange,
} from "@checkpointvcs/common";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  getWorkspaceConfig,
  getWorkspaceState,
  saveWorkspaceConfig,
  type Workspace as UtilWorkspace,
  type WorkspaceLinkedWorkspace,
  type WorkspaceTeamSyncSettings,
} from "../../../util/util.js";
import { DaemonConfig } from "../../../daemon-config.js";
import { createAndRegisterWorkspace } from "./ops.js";
import { getProjectInfo } from "../../../util/unreal/index.js";
import { compileFilter } from "../../../util/team-sync/filter.js";
import { previewClean, executeClean } from "../../../util/team-sync/clean.js";
import { getLinkStatuses } from "../../../util/team-sync/linked-repos.js";
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
      domainBranchName: workspace.domainBranchName,
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

const linkModeInput = z.enum(["follow-pin", "manual", "ignore"]);

/**
 * Writes this workspace's choice for one link to its workspace.json,
 * replacing any entry spelled with different case.
 */
async function saveLinkEntry(
  parent: Workspace,
  repo: string,
  entry: WorkspaceLinkedWorkspace,
): Promise<WorkspaceTeamSyncSettings> {
  const persisted = await getWorkspaceConfig(parent.localPath);
  if (!persisted) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Workspace config missing on disk for ${parent.id}`,
    });
  }
  const teamSync: WorkspaceTeamSyncSettings = persisted.teamSync ?? {};
  const entries = Object.fromEntries(
    Object.entries(teamSync.linkedWorkspaces ?? {}).filter(
      ([name]) => name.toLowerCase() !== repo.toLowerCase(),
    ),
  );
  entries[repo] = entry;
  persisted.teamSync = { ...teamSync, linkedWorkspaces: entries };
  await saveWorkspaceConfig(persisted);
  return persisted.teamSync;
}

/** Whether one folder is, contains, or is inside the other. */
function pathsOverlap(a: string, b: string): boolean {
  const caseless =
    process.platform === "win32" || process.platform === "darwin";
  const norm = (p: string) => {
    const resolved = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return caseless ? resolved.toLowerCase() : resolved;
  };
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

const settingsInput = z.object({
  // Linked repo name -> this workspace's choice; see setLinkedWorkspace for
  // the validated way to set one entry.
  linkedWorkspaces: z
    .record(
      z.string(),
      z.object({ workspaceId: z.string().optional(), mode: linkModeInput }),
    )
    .optional(),
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
        ifOs: z.array(z.enum(["windows", "macos", "linux"])).optional(),
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
          name: workspace.domainBranchName,
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

  // ── Linked repos ─────────────────────────────────────────────────

  // Every link in the repo config at the workspace's changelist (or the one
  // given), with this machine's choice for it and where that workspace is.
  getLinkedRepos: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      return getLinkStatuses(
        await loadUtilWorkspace(workspace),
        workspace.orgId,
        ctx.manager.linkedSyncDeps(),
        input.changelistNumber,
      );
    }),

  // Workspaces on this machine that can satisfy a link: same org, the linked
  // repo, and the link's branch when given.
  listLinkCandidates: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        repo: z.string(),
        branch: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const parent = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const client = await CreateApiClientAuth(input.daemonId);
      const candidates: {
        id: string;
        name: string;
        localPath: string;
        domainBranchName: string;
      }[] = [];
      for (const workspaces of ctx.manager.workspaces.values()) {
        for (const w of workspaces) {
          if (w.id === parent.id || w.orgId !== parent.orgId) continue;
          if (input.branch && w.domainBranchName !== input.branch) continue;
          const repo = await client.repo.getRepo
            .query({ id: w.repoId })
            .catch(() => null);
          if (repo?.name.toLowerCase() !== input.repo.toLowerCase()) continue;
          candidates.push({
            id: w.id,
            name: w.name,
            localPath: w.localPath,
            domainBranchName: w.domainBranchName,
          });
        }
      }
      return candidates;
    }),

  // Sets this workspace's choice for one link. A workspace, when given, must
  // be registered here and hold the linked repo; ignore needs none.
  setLinkedWorkspace: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        repo: z.string().min(1),
        mode: linkModeInput,
        linkedWorkspaceId: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const parent = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      if (input.linkedWorkspaceId === parent.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A workspace cannot be linked to itself.",
        });
      }
      if (input.linkedWorkspaceId) {
        const linked = ctx.manager
          .linkedSyncDeps()
          .findWorkspace(input.linkedWorkspaceId);
        if (!linked) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Workspace ${input.linkedWorkspaceId} is not registered on this machine.`,
          });
        }
        const client = await CreateApiClientAuth(linked.daemonId);
        const repo = await client.repo.getRepo.query({ id: linked.repoId });
        if (
          repo?.name.toLowerCase() !== input.repo.toLowerCase() ||
          repo.orgId !== parent.orgId
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Workspace ${linked.name} holds ${repo?.name ?? "another repo"}, not ${input.repo}.`,
          });
        }
      }

      return saveLinkEntry(parent, input.repo, {
        mode: input.mode,
        ...(input.linkedWorkspaceId && {
          workspaceId: input.linkedWorkspaceId,
        }),
      });
    }),

  // Creates a workspace of a linked repo in a folder the user picked, on the
  // link's branch, and links it. It starts empty; the parent's next sync
  // brings it to the pin. Only for links that can live anywhere on disk.
  createLinkedWorkspace: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        repo: z.string().min(1),
        path: z.string().min(1),
        name: z.string().min(1).max(100),
        mode: z.enum(["follow-pin", "manual"]).default("follow-pin"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const parent = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );

      if (!path.isAbsolute(input.path)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose a full folder path for the new workspace.",
        });
      }
      // The link is saved there last; check now so a failure can't leave a
      // new workspace behind unlinked.
      if (!(await getWorkspaceConfig(parent.localPath))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace config missing on disk for ${parent.id}`,
        });
      }
      // A workspace inside another (or around one) would show the inner
      // one's files as untracked in the outer and could submit them to the
      // wrong repo. Nested links handle that case on purpose; this does not.
      for (const workspaces of ctx.manager.workspaces.values()) {
        for (const w of workspaces) {
          if (pathsOverlap(input.path, w.localPath)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `That folder overlaps workspace ${w.name} (${w.localPath}). Choose a folder outside every workspace.`,
            });
          }
        }
      }

      const backend = (await DaemonConfig.Get()).stateBackend;
      const parentState = await getWorkspaceState(parent.localPath, backend);
      const client = await CreateApiClientAuth(input.daemonId);
      const { config } = await client.teamSync.getConfig.query({
        repoId: parent.repoId,
        changelistNumber: parentState.changelistNumber,
      });
      const link = config?.linkedRepos?.find(
        (l) => l.repo.toLowerCase() === input.repo.toLowerCase(),
      );
      if (!link) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `This workspace's Team Sync config has no link to ${input.repo}.`,
        });
      }
      if (link.path !== undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${link.repo} is mounted at ${link.path} inside this workspace, which Team Sync does not support yet.`,
        });
      }

      // getOrg lists the repos this user can reach, including through the
      // org's default repo access (repo.list leaves those out).
      const org = await client.org.getOrg.query({ id: parent.orgId });
      const repo = (org?.repos ?? []).find(
        (r) => !r.deletedAt && r.name.toLowerCase() === link.repo.toLowerCase(),
      );
      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No repo named ${link.repo} in this organization, or you don't have access to it.`,
        });
      }

      await fs.mkdir(input.path, { recursive: true });
      const created = await createAndRegisterWorkspace(ctx.manager, {
        daemonId: input.daemonId,
        name: input.name,
        repoId: repo.id,
        path: input.path,
        defaultBranchName: link.branch,
      });

      const settings = await saveLinkEntry(parent, link.repo, {
        mode: input.mode,
        workspaceId: created.id,
      });
      return {
        workspace: {
          id: created.id,
          name: created.name,
          localPath: created.localPath,
        },
        settings,
      };
    }),

  // The linked repo pins that differ between the repo config at two
  // changelists (bisect's range). Null when either config is invalid.
  comparePins: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        fromChangelist: z.number().int().min(0),
        toChangelist: z.number().int().min(0),
      }),
    )
    .query(async ({ ctx, input }): Promise<TeamSyncPinChange[] | null> => {
      const workspace = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const client = await CreateApiClientAuth(input.daemonId);
      return client.teamSync.comparePins.query({
        repoId: workspace.repoId,
        fromChangelist: input.fromChangelist,
        toChangelist: input.toChangelist,
      });
    }),

  // Removes this workspace's choice for a link, so it falls back to the
  // preset or "not set up".
  clearLinkedWorkspace: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        repo: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const parent = resolveWorkspace(
        ctx.manager,
        input.daemonId,
        input.workspaceId,
      );
      const persisted = await getWorkspaceConfig(parent.localPath);
      if (!persisted?.teamSync?.linkedWorkspaces) {
        return persisted?.teamSync ?? {};
      }
      persisted.teamSync.linkedWorkspaces = Object.fromEntries(
        Object.entries(persisted.teamSync.linkedWorkspaces).filter(
          ([name]) => name.toLowerCase() !== input.repo.toLowerCase(),
        ),
      );
      await saveWorkspaceConfig(persisted);
      return persisted.teamSync;
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
          domainBranchName: workspace.domainBranchName,
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
          domainBranchName: workspace.domainBranchName,
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
          domainBranchName: workspace.domainBranchName,
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
          branchName: workspace.domainBranchName,
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
