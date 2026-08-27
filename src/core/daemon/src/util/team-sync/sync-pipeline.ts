import { existsSync, promises as fs } from "fs";
import path from "path";
import {
  CreateApiClientAuth,
  type TeamSyncConfig,
} from "@checkpointvcs/common";

import {
  getWorkspaceConfig,
  getWorkspaceState,
  saveWorkspaceState,
  type Workspace,
} from "../util.js";
import { pull, type PullMergeResult } from "../pull.js";
import { applyArtifacts, type AppliedArtifactSummary } from "./artifacts.js";
import { compileFilter, type CompiledSyncFilter } from "./filter.js";
import { writeVersionFiles } from "../build/version-files.js";
import { reportSyncedChangelist } from "./events.js";
import { DaemonConfig } from "../../daemon-config.js";
import { Logger } from "../../logging.js";

export interface SyncPipelineOptions {
  changelistId: number | null;
  filePaths: string[] | null;
  reportProgress: boolean;
  onStep?: (step: string) => void;
  onProgress?: (step: string, done: number, total: number) => void;
}

export interface SyncPipelineResult {
  mergeResult: PullMergeResult;
  syncedChangelistNumber: number;
  appliedArtifacts: AppliedArtifactSummary[];
  missingArtifactTypes: string[];
  wroteVersionFiles: boolean;
  filteredOutCount: number;
}

/**
 * The Team Sync sync pipeline: source pull, then optional precompiled-binary
 * application (decoupled from the source CL), optional version-file rewrite,
 * and presence reporting. Shared by manual pull, scheduled sync, and the CLI.
 *
 * The artifact and version-file steps read per-workspace settings from
 * workspace.json; when Team Sync is not configured this behaves like a plain
 * pull.
 */
export async function runSyncPipeline(
  workspace: Workspace,
  orgId: string,
  options: SyncPipelineOptions,
): Promise<SyncPipelineResult> {
  const { onStep, onProgress } = options;

  const mergeResult = await pull(
    workspace,
    orgId,
    options.changelistId,
    options.filePaths,
    undefined,
    onStep,
    onProgress,
    (changelistNumber) =>
      resolveNativeIncludeRules(workspace, changelistNumber),
  );

  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);
  const syncedChangelistNumber = state.changelistNumber;

  const config = await getWorkspaceConfig(workspace.localPath);
  const settings = config?.teamSync;

  // Reconcile the sync filter: remove files that the current filter excludes
  // and record the applied filter hash. Newly-included files are picked up by
  // the normal pull diff on subsequent syncs.
  //
  // The pull above already skips most excluded files natively, so this usually
  // has nothing to delete. It still runs unconditionally, because it is the
  // authority: it applies the exclude rules the native filter is never given,
  // it covers files left over from an earlier, wider filter, and it handles the
  // syncs where native filtering was declined outright.
  const filteredOutCount = await reconcileSyncFilter(
    workspace,
    orgId,
    syncedChangelistNumber,
    backend,
    onStep,
  );

  let appliedArtifacts: AppliedArtifactSummary[] = [];
  let missingArtifactTypes: string[] = [];
  let artifactsApplied = false;

  const hasExistingArtifacts =
    Object.keys(state.artifactFiles ?? {}).length > 0 ||
    Object.keys(state.teamSync?.appliedArtifacts ?? {}).length > 0;

  if (settings && (settings.usePrecompiledBinaries || hasExistingArtifacts)) {
    const result = await applyArtifacts(
      workspace,
      orgId,
      syncedChangelistNumber,
      settings,
      onStep,
      onProgress,
    );
    appliedArtifacts = result.applied;
    missingArtifactTypes = result.missingTypes;
    artifactsApplied = result.applied.length > 0;
  }

  // Version files: opt-in, and skipped when precompiled binaries were applied
  // (those carry their own baked version).
  let wroteVersionFiles = false;
  if (settings?.writeVersionFiles && !artifactsApplied) {
    onStep?.("Writing version files");
    wroteVersionFiles = await writeVersionFiles(
      workspace,
      syncedChangelistNumber,
      workspace.branchName,
    );
  }

  // Presence (fire-and-forget).
  void reportSyncedChangelist(workspace, syncedChangelistNumber).catch(
    (err) => {
      Logger.warn(`Sync event reporting failed: ${err}`);
    },
  );

  return {
    mergeResult,
    syncedChangelistNumber,
    appliedArtifacts,
    missingArtifactTypes,
    wroteVersionFiles,
    filteredOutCount,
  };
}

/**
 * Compile the workspace's effective sync filter against the repo config at a
 * changelist. A repo config the daemon can't reach yields a filter built from
 * the workspace's own rules alone, so a transient API failure never widens into
 * mass deletion; `repoConfigResolved` reports whether that happened.
 */
async function resolveSyncFilter(
  workspace: Workspace,
  changelistNumber: number,
): Promise<{ filter: CompiledSyncFilter; repoConfigResolved: boolean }> {
  const config = await getWorkspaceConfig(workspace.localPath);

  let repoConfig: TeamSyncConfig | null = null;
  let repoConfigResolved = false;
  try {
    const client = await CreateApiClientAuth(workspace.daemonId);
    const result = await client.teamSync.getConfig.query({
      repoId: workspace.repoId,
      changelistNumber,
    });
    repoConfig = result.config;
    repoConfigResolved = true;
  } catch (err) {
    Logger.warn(`Sync filter: failed to resolve repo config: ${err}`);
  }

  return {
    filter: compileFilter(repoConfig, config?.teamSync),
    repoConfigResolved,
  };
}

/**
 * The include rules to hand the native pull for the CL about to be synced, or
 * null to pull everything and filter afterwards.
 *
 * Declines whenever the answer might be too narrow: a repo config that didn't
 * resolve would drop whole categories from the rule set, and skipping a file
 * natively is not something the post-pull reconcile can undo. Declining only
 * costs bandwidth, so every uncertain case takes that branch.
 */
async function resolveNativeIncludeRules(
  workspace: Workspace,
  changelistNumber: number,
): Promise<string[] | null> {
  try {
    const { filter, repoConfigResolved } = await resolveSyncFilter(
      workspace,
      changelistNumber,
    );
    if (!repoConfigResolved) return null;
    return filter.nativeIncludeRules;
  } catch (err) {
    Logger.warn(`Sync filter: native include rules unavailable: ${err}`);
    return null;
  }
}

/**
 * Apply the workspace's sync filter after a pull: delete now-excluded files
 * from disk and from tracked state, then persist the resolved filter hash.
 * Returns the number of files removed. No-op when the filter is unset.
 */
async function reconcileSyncFilter(
  workspace: Workspace,
  orgId: string,
  changelistNumber: number,
  backend: Awaited<ReturnType<typeof DaemonConfig.Get>>["stateBackend"],
  onStep?: (step: string) => void,
): Promise<number> {
  void orgId;
  const { filter } = await resolveSyncFilter(workspace, changelistNumber);
  const state = await getWorkspaceState(workspace.localPath, backend);
  const currentHash = state.teamSync?.syncFilterHash;

  if (filter.isNoOp) {
    // Clear a previously applied filter hash so a later narrowing re-runs.
    if (currentHash !== undefined) {
      await saveWorkspaceState(
        workspace,
        {
          ...state,
          teamSync: { ...(state.teamSync ?? {}), syncFilterHash: undefined },
        },
        backend,
      );
    }
    return 0;
  }

  const excluded = Object.keys(state.files).filter(
    (relPath) => !filter.matches(relPath),
  );

  if (excluded.length > 0) {
    onStep?.("Applying sync filter");
    const nextFiles = { ...state.files };
    for (const relPath of excluded) {
      const full = path.join(workspace.localPath, relPath);
      if (existsSync(full)) {
        await fs.rm(full, { force: true });
      }
      delete nextFiles[relPath];
    }
    await saveWorkspaceState(
      workspace,
      {
        ...state,
        files: nextFiles,
        teamSync: { ...(state.teamSync ?? {}), syncFilterHash: filter.hash },
      },
      backend,
    );
  } else if (currentHash !== filter.hash) {
    await saveWorkspaceState(
      workspace,
      {
        ...state,
        teamSync: { ...(state.teamSync ?? {}), syncFilterHash: filter.hash },
      },
      backend,
    );
  }

  return excluded.length;
}
