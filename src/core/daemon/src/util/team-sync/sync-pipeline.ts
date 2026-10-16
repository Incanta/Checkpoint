import { existsSync, promises as fs } from "fs";
import path from "path";
import {
  CreateApiClientAuth,
  type TeamSyncConfig,
} from "@checkpointvcs/common";

import {
  getWorkspaceConfig,
  getWorkspaceState,
  updateWorkspaceState,
  type Workspace,
  syncTargetBranch,
} from "../util.js";
import { pull, type PullMergeResult } from "../pull.js";
import { applyArtifacts, type AppliedArtifactSummary } from "./artifacts.js";
import { compileFilter, type CompiledSyncFilter } from "./filter.js";
import { writeVersionFiles } from "../build/version-files.js";
import { reportSyncedChangelist } from "./events.js";
import { DaemonConfig } from "../../daemon-config.js";
import { Logger } from "../../logging.js";
import { isSafeWorkspacePath, resolveInWorkspace } from "../workspace-path.js";
import { hasLocalChanges } from "../pull-local-changes.js";

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
  /** Excluded files kept because they hold local work (see reconcileSyncFilter). */
  filterKept: string[];
  /** Excluded files the reconcile could not remove. */
  filterFailed: { path: string; error: string }[];
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
    (changelistNumber, tracked) =>
      resolveNewlyIncluded(workspace, changelistNumber, tracked),
  );

  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);
  const syncedChangelistNumber = state.changelistNumber;

  const config = await getWorkspaceConfig(workspace.localPath);
  const settings = config?.teamSync;

  // Reconcile the sync filter: remove files that the current filter excludes
  // and record the applied filter hash. Files a wider filter now includes were
  // brought in by the pull itself (resolveNewlyIncluded), since no diff would
  // mention them again unless they changed upstream.
  //
  // The pull above already skips most excluded files natively, so this usually
  // has nothing to delete. It still runs unconditionally, because it is the
  // authority: it applies the exclude rules the native filter is never given,
  // it covers files left over from an earlier, wider filter, and it handles the
  // syncs where native filtering was declined outright.
  const reconcile = await reconcileSyncFilter(
    workspace,
    orgId,
    syncedChangelistNumber,
    backend,
    onStep,
    mergeResult.pulledPaths,
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
      syncTargetBranch(workspace),
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
    filteredOutCount: reconcile.removed,
    filterKept: reconcile.kept,
    filterFailed: reconcile.failed,
  };
}

/**
 * Compile the workspace's effective sync filter against the repo config at a
 * changelist. A repo config the daemon can't reach yields a filter built from
 * the workspace's own rules alone, which can be far narrower than the real
 * one; `repoConfigResolved` reports whether that happened, and nothing may
 * delete files by such a filter.
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
 * Files the target changelist has, the workspace's current filter includes,
 * and the workspace does not track: the ones an earlier, narrower filter left
 * out. Only looked for when the filter changed since it was last applied,
 * since that is the only way such files come about. Lists the whole target
 * tree, so it is not free, but a filter change is rare.
 */
async function resolveNewlyIncluded(
  workspace: Workspace,
  changelistNumber: number,
  tracked: ReadonlySet<string>,
): Promise<{ path: string; cl: number; fileId: string }[]> {
  try {
    const { filter, repoConfigResolved } = await resolveSyncFilter(
      workspace,
      changelistNumber,
    );
    if (!repoConfigResolved) return [];
    const backend = (await DaemonConfig.Get()).stateBackend;
    const state = await getWorkspaceState(workspace.localPath, backend);
    const applied = state.teamSync?.syncFilterHash;
    // No filter applied before means nothing was left out.
    if (applied === undefined) return [];
    if (!filter.isNoOp && applied === filter.hash) return [];

    const client = await CreateApiClientAuth(workspace.daemonId);
    const everything = await client.changelist.diffChangelists.query({
      repoId: workspace.repoId,
      fromNumber: 0,
      toNumber: changelistNumber,
    });
    return everything.added.filter(
      (c: { path: string }) =>
        !tracked.has(c.path) && (filter.isNoOp || filter.matches(c.path)),
    );
  } catch (err) {
    Logger.warn(`Sync filter: could not look for newly included files: ${err}`);
    return [];
  }
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

export interface ReconcileResult {
  /** Files the filter excluded and the reconcile removed. */
  removed: number;
  /**
   * Files the filter excludes that were kept, because they hold local work:
   * edited, staged, marked for add, or claimed by this workspace. They stay
   * tracked, so they keep showing as pending changes.
   */
  kept: string[];
  /** Files it could not remove, with why. They stay tracked. */
  failed: { path: string; error: string }[];
  /** Set when the repo config could not be read, so nothing was touched. */
  skipped?: "repo-config-unavailable";
}

/**
 * Apply the workspace's sync filter after a pull: delete now-excluded files
 * from disk and from tracked state, then persist the resolved filter hash.
 * No-op when the filter is unset.
 *
 * It never deletes work. When the repo config cannot be read the filter is
 * unknown, which is not the same as empty, so nothing is touched and the
 * applied hash stays as it was. A file with local work is kept and reported.
 * Each removed file leaves the state as it goes, so a delete that fails
 * partway (a file open in another program) never leaves the files removed
 * before it looking deleted by the user.
 */
async function reconcileSyncFilter(
  workspace: Workspace,
  orgId: string,
  changelistNumber: number,
  backend: Awaited<ReturnType<typeof DaemonConfig.Get>>["stateBackend"],
  onStep?: (step: string) => void,
  pulledPaths?: string[],
): Promise<ReconcileResult> {
  void orgId;
  const result: ReconcileResult = { removed: 0, kept: [], failed: [] };
  const { filter, repoConfigResolved } = await resolveSyncFilter(
    workspace,
    changelistNumber,
  );
  if (!repoConfigResolved) {
    Logger.warn(
      "Sync filter: repo config unavailable; leaving every file in place",
    );
    result.skipped = "repo-config-unavailable";
    return result;
  }
  const state = await getWorkspaceState(workspace.localPath, backend);
  const currentHash = state.teamSync?.syncFilterHash;

  if (filter.isNoOp) {
    // Clear a previously applied filter hash so a later narrowing re-runs.
    if (currentHash !== undefined) {
      await updateWorkspaceState(
        workspace,
        { meta: { syncFilterHash: null } },
        backend,
      );
    }
    return result;
  }

  // With the same filter already applied, every file the pull did not touch
  // passed it last time; only the pulled paths need checking. A changed
  // filter (or no record of what the pull touched) checks everything.
  const candidates =
    currentHash === filter.hash && pulledPaths
      ? pulledPaths.filter((p) => p in state.files)
      : Object.keys(state.files);
  const excluded = candidates.filter((relPath) => !filter.matches(relPath));

  if (excluded.length > 0) {
    onStep?.("Applying sync filter");
    const keep = new Set([
      ...(state.staged ?? []),
      ...(state.markedForAdd ?? []),
    ]);
    let claimed: Set<string> | null = new Set();
    try {
      const client = await CreateApiClientAuth(workspace.daemonId);
      const claims = await client.file.getWorkspaceClaims.query({
        workspaceId: workspace.id,
        repoId: workspace.repoId,
      });
      const ids = new Set(claims.map((c: { fileId: string }) => c.fileId));
      claimed = new Set(
        excluded.filter((p) => ids.has(state.files[p]?.fileId ?? "")),
      );
    } catch (err) {
      // Without the claims there is no knowing which files this workspace
      // holds locks on. Try again next sync rather than guess.
      Logger.warn(
        `Sync filter: could not read this workspace's claims: ${err}`,
      );
      claimed = null;
    }
    if (claimed === null) {
      result.kept.push(...excluded);
      return result;
    }

    const removed: string[] = [];
    try {
      for (const relPath of excluded) {
        if (!isSafeWorkspacePath(relPath)) {
          // Never on disk here (see workspace-path.ts); just stop tracking it.
          removed.push(relPath);
          continue;
        }
        const full = resolveInWorkspace(workspace.localPath, relPath);
        if (
          keep.has(relPath) ||
          claimed.has(relPath) ||
          (await hasLocalChanges(full, state.files[relPath]))
        ) {
          result.kept.push(relPath);
          continue;
        }
        try {
          if (existsSync(full)) {
            await fs.rm(full, { force: true });
          }
          removed.push(relPath);
        } catch (err) {
          result.failed.push({
            path: relPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      // Whatever was removed leaves the state, even if something above threw.
      // Kept and failed files stay tracked, so none of them looks deleted.
      await updateWorkspaceState(
        workspace,
        {
          files: { delete: removed },
          meta: { syncFilterHash: filter.hash },
        },
        backend,
      );
    }
    result.removed = removed.length;
    if (result.kept.length > 0) {
      Logger.info(
        `Sync filter: kept ${result.kept.length} excluded file(s) with local work: ${result.kept.join(", ")}`,
      );
    }
    if (result.failed.length > 0) {
      Logger.warn(
        `Sync filter: could not remove ${result.failed.length} file(s): ${result.failed
          .map((f) => `${f.path} (${f.error})`)
          .join(", ")}`,
      );
    }
  } else if (currentHash !== filter.hash) {
    await updateWorkspaceState(
      workspace,
      { meta: { syncFilterHash: filter.hash } },
      backend,
    );
  }

  return result;
}
