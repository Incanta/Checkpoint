import path from "path";
import { DaemonConfig, DaemonConfigType } from "./daemon-config.js";
import { InitLogger, Logger } from "./logging.js";
import {
  FileStatus,
  FileType,
  type File,
  type FileClaimInfo,
  type Workspace,
  type WorkspacePendingChanges,
} from "./types/index.js";
import {
  watch,
  type FSWatcher,
  type Stats,
  promises as fs,
  existsSync,
  Dirent,
} from "fs";
import {
  CreateApiClientAuth,
  hashFileMD5,
  type WorkspaceStateFile,
} from "@checkpointvcs/common";
import {
  getWorkspaceState,
  updateWorkspaceState,
  getWorkspaceConfig,
  saveWorkspaceConfig,
  closeAllStateStores,
  closeStateStore,
  resolveBranchChain,
  type WorkspaceState,
} from "./util/index.js";
import {
  TeamSyncScheduler,
  type ScheduledWorkspace,
} from "./util/team-sync/scheduler.js";
import { runSyncPipeline } from "./util/team-sync/sync-pipeline.js";
import { compareWithBaseline } from "./util/baseline.js";
import { recoverInterruptedPull } from "./util/interrupted-pull.js";
import {
  isSafeWorkspacePath,
  resolveInWorkspace,
  toRelativeRepoPath,
  unsupportedNameReason,
} from "./util/workspace-path.js";
import { groupByKey, workspacePathKey } from "./util/volume.js";
import type { StateDelta } from "./util/state-delta.js";
import { PathIndex, pathsUnderAny } from "./util/path-index.js";
import {
  scanWorkspaceIgnoreFiles,
  buildIgnoreCacheFromPatterns,
  getFileStatuses as computeFileStatuses,
  isIgnoredOrHidden,
  normalizeRelativePath,
  IGNORE_FILE,
  HIDDEN_FILE,
  type WorkspaceIgnorePatterns,
  type IgnoreCache,
  type FileStatusResult,
} from "./file-status.js";
import { checkSyncStatus, type SyncStatus } from "./util/sync-status.js";
import { hasConflictMarkers } from "./util/auto-merge.js";
import { getBinaryExtensions, isBinaryFile } from "./util/binary-extensions.js";

/** Whether a repo-relative path is the workspace's .checkpoint directory or inside it. */
function isCheckpointDirPath(relativePath: string): boolean {
  return (
    relativePath === ".checkpoint" || relativePath.startsWith(".checkpoint/")
  );
}

export class DaemonManager {
  private static instance: DaemonManager | null = null;

  /** The key for this map is the daemonId of the user */
  public workspaces: Map<string, Workspace[]> = new Map();

  /** Cached workspace state from state.json, keyed by workspace.id */
  private workspaceStates: Map<string, WorkspaceState> = new Map();

  /** Set of files that have been modified since last full refresh, keyed by workspace.id */
  private dirtyFiles: Map<string, Set<string>> = new Map();

  /** Cached pending changes, keyed by workspace.id */
  public workspacePendingChanges: Map<string, WorkspacePendingChanges> =
    new Map();

  /** Resolved state backend from daemon config (set during init) */
  private stateBackend: DaemonConfigType["stateBackend"] = "json";

  /** Whether this is a short-lived, CLI-spawned daemon (initEphemeral). */
  public ephemeral = false;

  private watchers: Map<string, FSWatcher> = new Map();

  /** Pending restarts of watchers that failed, keyed by workspace.id */
  private watcherRetries: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  /**
   * Delay (ms) before restarting a failed watcher. It doubles on each failed
   * attempt, up to {@link WATCHER_RETRY_MAX_MS}. Not readonly so tests can
   * shorten it.
   */
  public static watcherRetryMs = 5000;
  private static readonly WATCHER_RETRY_MAX_MS = 60_000;

  /** Cached sync status per workspace, keyed by workspace.id */
  private syncStatuses: Map<string, SyncStatus> = new Map();

  /** Cached set of directories containing tracked files, keyed by workspace.id */
  private pathIndexes: Map<string, PathIndex> = new Map();

  /** Pre-loaded ignore/hidden patterns per workspace, keyed by workspace.id */
  private ignorePatterns: Map<string, WorkspaceIgnorePatterns> = new Map();

  /** Pre-built IgnoreCache per workspace, keyed by workspace.id */
  private ignoreCaches: Map<string, IgnoreCache> = new Map();

  /** Interval handle for sync polling */
  private syncPollInterval: ReturnType<typeof setInterval> | null = null;

  /** Daemon-owned scheduled-sync driver (Team Sync). */
  private teamSyncScheduler: TeamSyncScheduler | null = null;

  /**
   * Workspaces currently undergoing a VCS operation (pull/submit/merge).
   * While set, the file watcher buffers events instead of marking files
   * dirty so that mid-operation queries don't produce false pending changes.
   */
  private vcsOperationActive: Map<string, boolean> = new Map();

  /**
   * File-change events buffered during a VCS operation, keyed by workspace.id.
   * After the operation ends these are replayed into {@link dirtyFiles} so
   * legitimate user edits (e.g. editing file D while pulling A, B, C) are
   * still detected on the next refresh.
   */
  private vcsBufferedEvents: Map<string, Set<string>> = new Map();

  /** Sync poll interval in milliseconds (5 minutes) */
  private static readonly SYNC_POLL_INTERVAL_MS = 5 * 60 * 1000;

  /** Max dirty files before falling back to full refresh */
  private static readonly INCREMENTAL_DIRTY_THRESHOLD = 5000;

  /** Grace period (ms) after a VCS operation ends before re-enabling the watcher */
  private static readonly VCS_GRACE_PERIOD_MS = 500;

  private constructor() {
    //
  }

  public static Get(): DaemonManager {
    if (!DaemonManager.instance) {
      DaemonManager.instance = new DaemonManager();
    }
    return DaemonManager.instance;
  }

  public async init(): Promise<void> {
    await DaemonConfig.Load();

    const config = await DaemonConfig.Get();
    this.stateBackend = config.stateBackend;
    for (const workspace of config.workspaces) {
      await this.registerWorkspace(workspace);
    }

    await InitLogger();

    // Start sync polling for all workspaces
    this.startSyncPolling();

    // Start the daemon-owned scheduled-sync driver (Team Sync).
    this.startTeamSyncScheduler();
  }

  /**
   * Start the Team Sync scheduled-sync driver. It periodically runs the sync
   * pipeline for workspaces that have a daily schedule configured, even while
   * the desktop app is closed.
   */
  private startTeamSyncScheduler(): void {
    if (this.teamSyncScheduler) return;

    this.teamSyncScheduler = new TeamSyncScheduler({
      listScheduled: async () => {
        const items: ScheduledWorkspace[] = [];
        for (const workspaces of this.workspaces.values()) {
          for (const workspace of workspaces) {
            const config = await getWorkspaceConfig(workspace.localPath);
            if (config?.teamSync?.scheduledSync?.enabled) {
              items.push({ workspace: config, orgId: workspace.orgId });
            }
          }
        }
        return items;
      },
      isBusy: (workspaceId) =>
        this.vcsOperationActive.get(workspaceId) === true,
      runScheduledSync: async (item, targetChangelist) => {
        const { workspace, orgId } = item;
        // The manager workspace (registry entry) is needed for state reload;
        // the util workspace (config) drives the pipeline.
        const managerWorkspace = this.findWorkspaceById(workspace.id);
        this.beginVcsOperation(workspace.id);
        try {
          await runSyncPipeline(workspace, orgId, {
            changelistId: targetChangelist,
            filePaths: null,
            reportProgress: false,
          });
          if (managerWorkspace) {
            await this.reloadWorkspaceState(managerWorkspace);
          }
          this.clearSyncStatus(workspace.id);
        } finally {
          await this.endVcsOperation(workspace.id);
        }

        // Persist the run time so the schedule does not re-fire on restart.
        await updateWorkspaceState(
          workspace,
          { meta: { lastScheduledSyncAt: new Date().toISOString() } },
          this.stateBackend,
        );
      },
    });

    this.teamSyncScheduler.start();
  }

  /**
   * Ephemeral init for a daemonless CLI invocation: registers ONLY the single
   * workspace rooted at `workspacePath` and skips all background machinery
   * (fs watchers and the 5-minute sync poll). Change detection still works on
   * demand via {@link refreshWorkspaceContents} because it recovers state from
   * the on-disk baseline (state.json / state.db) plus the current filesystem.
   *
   * `workspacePath` may be omitted for auth-only invocations (e.g. `login`,
   * `accounts`), which don't need a workspace registered at all.
   */
  public async initEphemeral(workspacePath?: string | null): Promise<void> {
    await DaemonConfig.Load();

    const config = await DaemonConfig.Get();
    this.stateBackend = config.stateBackend;
    this.ephemeral = true;

    await InitLogger({ ephemeral: true });

    if (!workspacePath) {
      // Auth/version-only ephemeral daemon: nothing further to register.
      return;
    }

    const wsConfig = await getWorkspaceConfig(workspacePath);
    if (!wsConfig) {
      throw new Error(
        `No Checkpoint workspace found at ${workspacePath} (missing .checkpoint/workspace.json)`,
      );
    }

    // .checkpoint/workspace.json stores the lean config shape; the manager
    // works with the richer server Workspace. The server-owned fields
    // (userId, orgId, createdAt, deletedAt) are not persisted locally and are
    // unused by local operations, so fill them with inert placeholders. These
    // are never written back to the shared daemon.json in ephemeral mode.
    const workspace: Workspace = {
      id: wsConfig.id,
      repoId: wsConfig.repoId,
      name: wsConfig.workspaceName,
      domainBranchName: wsConfig.domainBranchName,
      activeBranches: wsConfig.activeBranches ?? [],
      localPath: workspacePath,
      daemonId: wsConfig.daemonId,
      userId: "",
      orgId: "",
      createdAt: new Date(0),
      deletedAt: null,
      syncedChangelistNumber: null,
      syncedAt: null,
    };

    await this.registerWorkspace(workspace, { watch: false });
    // Intentionally NO watchWorkspace() and NO startSyncPolling().
  }

  /**
   * Tells the server which domain root this workspace materializes from and
   * which feature branches it has overlaid.
   *
   * Claims are attributed per branch and taken at checkout time, so the server
   * needs the branch then, not only at submit. This also repairs a workspace
   * whose config predates overlays and recorded a feature branch as its
   * "branch": only the server knows which branch anchors the domain, so it
   * answers with the root and the feature branch becomes an overlay.
   *
   * Fire-and-forget. A daemon that cannot reach the server still works
   * offline, and the next registration reports again.
   */
  private async reportBranchState(workspace: Workspace): Promise<void> {
    try {
      const client = await CreateApiClientAuth(workspace.daemonId);

      const branch = await client.branch.getBranch.query({
        repoId: workspace.repoId,
        name: workspace.domainBranchName,
      });

      if (!branch) {
        return;
      }

      const domainBranchName = branch.isClaimDomainRoot
        ? branch.name
        : (branch.domainBranchName ?? branch.name);

      // A config that named a feature branch becomes root + that branch's
      // chain overlaid, which is the same tree described in the new
      // vocabulary. Otherwise the overlay is the chain of its deepest branch,
      // which is what the workspace syncs: a config that ended up with two
      // siblings active (older daemons could do that here) keeps the one it
      // was syncing.
      const deepest = branch.isClaimDomainRoot
        ? workspace.activeBranches?.at(-1)
        : branch.name;
      const activeBranches = deepest
        ? await resolveBranchChain(client, workspace.repoId, deepest)
        : [];
      // The branch is gone (deleted, or merged and deleted): leave the
      // workspace as it is rather than quietly dropping its overlay.
      if (deepest && activeBranches.length === 0) {
        return;
      }

      await client.workspace.setBranchState.mutate({
        workspaceId: workspace.id,
        domainBranchName,
        activeBranches,
      });

      workspace.domainBranchName = domainBranchName;
      workspace.activeBranches = activeBranches;
    } catch (err) {
      console.warn(
        `[branch-state] could not report branch state for workspace ${workspace.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Registers a workspace with the manager: adds it to the in-memory registry,
   * loads its baseline state, scans the working tree for ignore/hidden files,
   * and (unless disabled) starts a filesystem watcher.
   *
   * Every path that makes the manager aware of a workspace must go through
   * here. Workspaces created at runtime used to be pushed onto
   * {@link workspaces} directly, which skipped the ignore scan and left the
   * workspace with an empty ignore set until the daemon restarted.
   */
  public async registerWorkspace(
    workspace: Workspace,
    options?: { watch?: boolean },
  ): Promise<void> {
    const existing = this.workspaces.get(workspace.daemonId) ?? [];
    if (!existing.some((w) => w.id === workspace.id)) {
      existing.push(workspace);
    }
    this.workspaces.set(workspace.daemonId, existing);

    // A pull this daemon was running when it died (a crash, a reboot) put
    // the local edits it had backed up back, before anything reads the state.
    await recoverInterruptedPull(workspace, this.stateBackend).catch((err) =>
      Logger.warn(
        `Could not recover an interrupted pull in ${workspace.localPath}: ${err}`,
      ),
    );
    await this.loadWorkspaceState(workspace);
    await this.scanIgnoreFiles(workspace);
    void this.reportBranchState(workspace);

    if (options?.watch !== false) {
      this.watchWorkspace(workspace);
    }
  }

  public async shutdown(): Promise<void> {
    this.stopSyncPolling();
    this.watcherRetries.forEach((timer) => clearTimeout(timer));
    this.watcherRetries.clear();
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers.clear();
    closeAllStateStores();
  }

  /**
   * Unlinks a workspace: stops watching, clears all cached state.
   * Does NOT delete the .checkpoint directory on disk.
   */
  public unlinkWorkspace(workspaceId: string, daemonId: string): void {
    // Close file watcher, and cancel any pending restart of a failed one (it
    // would otherwise start watching the unlinked workspace again).
    this.cancelWatcherRetry(workspaceId);
    const watcher = this.watchers.get(workspaceId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(workspaceId);
    }

    // Release the workspace's state database, so its folder can be deleted.
    const localPath = this.findWorkspaceById(workspaceId)?.localPath;
    if (localPath) closeStateStore(localPath);

    // Clear all cached state
    this.workspaceStates.delete(workspaceId);
    this.dirtyFiles.delete(workspaceId);
    this.workspacePendingChanges.delete(workspaceId);
    this.syncStatuses.delete(workspaceId);
    this.pathIndexes.delete(workspaceId);
    this.ignorePatterns.delete(workspaceId);
    this.ignoreCaches.delete(workspaceId);
    this.vcsOperationActive.delete(workspaceId);
    this.vcsBufferedEvents.delete(workspaceId);

    // Remove from in-memory workspace list
    const workspaces = this.workspaces.get(daemonId) ?? [];
    this.workspaces.set(
      daemonId,
      workspaces.filter((w) => w.id !== workspaceId),
    );
  }

  /**
   * Loads the workspace state from state.json and caches it.
   */
  private async loadWorkspaceState(workspace: Workspace): Promise<void> {
    const state = await getWorkspaceState(
      workspace.localPath,
      this.stateBackend,
    );
    this.workspaceStates.set(workspace.id, state);
    this.dirtyFiles.set(workspace.id, new Set());
    this.pathIndexes.delete(workspace.id);
  }

  // ─── Ignore / Hidden File Management ────────────────────────────────

  /**
   * Scans the workspace's **working tree** for `.chkignore` / `.chkhidden`
   * files and caches the resulting patterns.
   *
   * Discovery intentionally ignores the submitted baseline (state.json). A repo
   * that has never submitted anything still has a meaningful `.chkignore` on
   * disk, and honouring only the submitted copy meant the very first
   * `chk status` in a new workspace listed every build artifact in the tree.
   */
  public async scanIgnoreFiles(workspace: Workspace): Promise<void> {
    if (!existsSync(workspace.localPath)) return;

    const patterns = await scanWorkspaceIgnoreFiles(workspace.localPath);

    this.ignorePatterns.set(workspace.id, patterns);

    // Pre-build the IgnoreCache so the first refresh is instant
    this.ignoreCaches.set(workspace.id, buildIgnoreCacheFromPatterns(patterns));
  }

  /**
   * Returns the pre-loaded ignore patterns for a workspace, or `undefined`
   * if they haven't been scanned yet.
   */
  public getIgnorePatterns(
    workspaceId: string,
  ): WorkspaceIgnorePatterns | undefined {
    return this.ignorePatterns.get(workspaceId);
  }

  /**
   * Handles a change to an ignore/hidden file detected by the watcher.
   *
   * Re-scans the whole working tree rather than patching the single file's
   * entry: editing an ignore file changes which subtrees are pruned, so ignore
   * files that were previously invisible (nested under a formerly-ignored
   * directory) can become relevant and vice versa. The scan prunes ignored
   * subtrees, and ignore-file edits are rare, so the cost is acceptable.
   */
  private async handleIgnoreFileChange(
    workspace: Workspace,
    relativePath: string,
  ): Promise<void> {
    const fileName = path.basename(relativePath);
    if (fileName !== IGNORE_FILE && fileName !== HIDDEN_FILE) return;

    await this.scanIgnoreFiles(workspace);

    Logger.debug(
      `[DaemonManager] Rebuilt ignore cache for workspace ${workspace.name} (${relativePath} changed)`,
    );
  }

  /**
   * Returns the cached {@link IgnoreCache} for a workspace. Always available
   * after the workspace has been registered.
   */
  public getIgnoreCache(workspaceId: string): IgnoreCache {
    const cached = this.ignoreCaches.get(workspaceId);
    if (cached) return cached;

    // Fallback for a workspace that was never scanned. Deliberately NOT
    // cached: caching an empty result here used to make a missed scan
    // permanent for the lifetime of the daemon, so nothing was ever ignored.
    Logger.warn(
      `[DaemonManager] No ignore patterns scanned for workspace ${workspaceId}; falling back to an empty ignore set`,
    );
    const empty: WorkspaceIgnorePatterns = { ignore: [], hidden: [] };
    return buildIgnoreCacheFromPatterns(empty);
  }

  // ─── File Status Helpers ───────────────────────────────────────────

  /**
   * Computes file statuses for a batch of files using the cached ignore
   * patterns. This is the single entry point that tRPC routes should use
   * instead of calling `getFileStatuses` from `file-status.ts` directly.
   */
  public async getFileStatuses(
    workspaceId: string,
    workspacePath: string,
    files: Array<{
      relativePath: string;
      existsOnDisk: boolean;
      isDirectory: boolean;
    }>,
    workspaceState: WorkspaceState | null,
    pendingChanges?: Record<
      string,
      { status: FileStatus; id: string | null; changelist: number | null }
    >,
  ): Promise<Map<string, FileStatusResult>> {
    const ignoreCache = this.getIgnoreCache(workspaceId);
    return computeFileStatuses(
      workspacePath,
      files,
      workspaceState,
      ignoreCache,
      pendingChanges,
    );
  }

  // ─── Directory Pending Helpers ─────────────────────────────────────

  /**
   * Recursively checks whether a directory (or any subdirectory beneath it)
   * contains at least one non-ignored, non-hidden **file**. The walk stops
   * as soon as the first qualifying file is found, so the cost is bounded
   * by the depth to the nearest file rather than the full subtree size.
   */
  private async hasNonIgnoredFiles(
    workspace: Workspace,
    relativeDir: string,
    ignoreCache: IgnoreCache,
  ): Promise<boolean> {
    const fullDir = path.join(workspace.localPath, relativeDir);
    try {
      const entries = await fs.readdir(fullDir, { withFileTypes: true });
      for (const entry of entries) {
        const childRelative = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name;
        if (
          isIgnoredOrHidden(ignoreCache, childRelative, entry.isDirectory())
        ) {
          continue;
        }

        if (entry.isFile() || entry.isSymbolicLink()) {
          return true;
        }

        if (entry.isDirectory()) {
          if (
            await this.hasNonIgnoredFiles(workspace, childRelative, ignoreCache)
          ) {
            return true;
          }
        }
      }
    } catch {
      // Directory not readable or doesn't exist
    }
    return false;
  }

  /**
   * For a given file path, finds the topmost ancestor directory that is NOT
   * in the tracked-directory set (walking from root downward). Returns the
   * relative directory path, or `null` if all ancestors are tracked.
   */
  private findTopmostUntrackedDir(
    relativePath: string,
    trackedDirs: { has(dir: string): boolean },
  ): string | null {
    const parts = relativePath.split("/");
    let current = "";

    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      if (!trackedDirs.has(current)) {
        return current;
      }
    }

    return null;
  }

  /**
   * Returns the pending children of a directory (one level deep).
   *
   * - Files: included only if they have a pending status (Local, Added,
   *   Changed*, Deleted, etc.)
   * - Directories: included if they are untracked with non-ignored children
   *   (status = Local) OR if they contain pending changes (status = Unknown).
   */
  public async getDirectoryPending(
    workspaceId: string,
    workspace: Workspace,
    rawDirectoryPath: string,
  ): Promise<{ children: File[]; containsChanges: boolean }> {
    const ignoreCache = this.getIgnoreCache(workspaceId);
    const workspaceState = this.getWorkspaceState(workspaceId);
    const trackedDirs = this.getTrackedDirSet(workspaceId);
    const pendingChanges = this.workspacePendingChanges.get(workspaceId);

    // Callers pass this straight through from a tRPC input, so it may arrive
    // with Windows separators or a leading slash.
    const directoryPath = normalizeRelativePath(rawDirectoryPath).replace(
      /\/+$/,
      "",
    );
    const dirPrefix = directoryPath ? directoryPath + "/" : "";
    const childrenMap = new Map<string, File>();

    // 1. Read directory contents from disk
    const fullDir = path.join(workspace.localPath, directoryPath);
    let diskEntries: Dirent[] = [];
    try {
      diskEntries = await fs.readdir(fullDir, { withFileTypes: true });
    } catch {
      // Directory may not exist on disk (entirely deleted)
    }

    for (const entry of diskEntries) {
      const relativePath = dirPrefix + entry.name;

      // Skip .checkpoint directory
      if (relativePath.startsWith(".checkpoint")) continue;

      // Skip ignored/hidden
      if (isIgnoredOrHidden(ignoreCache, relativePath, entry.isDirectory())) {
        continue;
      }

      if (entry.isDirectory()) {
        const isTracked = trackedDirs.has(relativePath);
        if (!isTracked) {
          // Untracked dir: include as Local if it contains non-ignored files
          if (
            await this.hasNonIgnoredFiles(workspace, relativePath, ignoreCache)
          ) {
            childrenMap.set(entry.name, {
              path: entry.name,
              type: FileType.Directory,
              size: 0,
              modifiedAt: 0,
              status: FileStatus.Local,
              id: null,
              changelist: null,
              claims: [],
              staged: false,
            });
          }
        } else {
          // Tracked dir: include if pending changes exist beneath it
          const subPrefix = relativePath + "/";
          const hasPending = pendingChanges
            ? Object.keys(pendingChanges.files).some((p) =>
                p.startsWith(subPrefix),
              )
            : false;

          if (hasPending) {
            childrenMap.set(entry.name, {
              path: entry.name,
              type: FileType.Directory,
              size: 0,
              modifiedAt: 0,
              status: FileStatus.Unknown,
              id: null,
              changelist: null,
              claims: [],
              staged: false,
            });
          }
        }
      } else {
        // File: check if it has a pending status
        const pendingFile = pendingChanges?.files[relativePath];
        if (pendingFile) {
          // Use the cached pending change result
          childrenMap.set(entry.name, {
            ...pendingFile,
            path: entry.name,
          });
        } else {
          // Check if the file is untracked (Local)
          const stateFile = workspaceState?.files[relativePath];
          if (!stateFile) {
            const stat = await fs.stat(path.join(fullDir, entry.name));
            childrenMap.set(entry.name, {
              path: entry.name,
              type: FileType.Text,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
              status: FileStatus.Local,
              id: null,
              changelist: null,
              claims: [],
              staged: false,
            });
          }
          // Tracked & not pending → skip (not a pending change)
        }
      }
    }

    // 2. Add items from cached pending changes not on disk (deleted files,
    //    deleted directories containing pending changes)
    if (pendingChanges) {
      const pendingSubdirs = new Set<string>();

      for (const [filePath, file] of Object.entries(pendingChanges.files)) {
        if (!filePath.startsWith(dirPrefix)) continue;
        const remainingPath = filePath.substring(dirPrefix.length);

        if (remainingPath.includes("/")) {
          // File is in a subdirectory
          const subdirName = remainingPath.split("/")[0];
          pendingSubdirs.add(subdirName);
        } else {
          // Direct child: add if not already present
          if (!childrenMap.has(remainingPath)) {
            childrenMap.set(remainingPath, {
              ...file,
              path: remainingPath,
            });
          }
        }
      }

      // Add subdirectories with pending changes not already in the map
      for (const subdirName of pendingSubdirs) {
        if (!childrenMap.has(subdirName)) {
          childrenMap.set(subdirName, {
            path: subdirName,
            type: FileType.Directory,
            size: 0,
            modifiedAt: 0,
            status: FileStatus.Unknown,
            id: null,
            changelist: null,
            claims: [],
            staged: false,
          });
        }
      }
    }

    const children = Array.from(childrenMap.values());
    const pendingStatuses = [
      FileStatus.Added,
      FileStatus.Renamed,
      FileStatus.Deleted,
      FileStatus.ChangedCheckedOut,
      FileStatus.ChangedNotCheckedOut,
      FileStatus.NotChangedCheckedOut,
      FileStatus.MergeConflict,
      FileStatus.Conflicted,
      FileStatus.Local,
    ];
    const containsChanges = children.some((c) =>
      pendingStatuses.includes(c.status),
    );

    return { children, containsChanges };
  }

  /**
   * Expands directory paths in the modifications list into individual file
   * entries. Used during submit so that a user can submit a whole directory
   * and the daemon will enumerate the files, applying ignore rules.
   *
   * The result is deduplicated by path. A selection may legitimately name both
   * a directory and files under it (pending changes reports untracked
   * directories as a single entry, and its tracked children individually), and
   * the same file must never be handed to the native submit twice: the addon
   * keys its file-size lookup by name, so one of the duplicates ends up with
   * size 0 and lands in the changelist as an empty file.
   */
  public async expandDirectoriesForSubmit(
    workspace: Workspace,
    modifications: Array<{
      delete: boolean;
      path: string;
      oldPath?: string;
    }>,
  ): Promise<Array<{ delete: boolean; path: string; oldPath?: string }>> {
    const ignoreCache = this.getIgnoreCache(workspace.id);
    const workspaceState = this.getWorkspaceState(workspace.id);
    const result: Array<{
      delete: boolean;
      path: string;
      oldPath?: string;
    }> = [];
    const seen = new Set<string>();
    const push = (mod: {
      delete: boolean;
      path: string;
      oldPath?: string;
    }): void => {
      const normalized = mod.path.replace(/^[/\\]/, "").replace(/\\/g, "/");
      if (seen.has(normalized)) return;
      seen.add(normalized);
      result.push({ ...mod, path: normalized });
    };

    // Classify modifications into files vs directories in parallel batches
    const CONCURRENCY = 256;
    type ClassifiedMod = {
      mod: { delete: boolean; path: string; oldPath?: string };
      normalizedPath: string;
      isDir: boolean;
    };

    const classified: ClassifiedMod[] = [];
    for (let i = 0; i < modifications.length; i += CONCURRENCY) {
      const batch = modifications.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (mod) => {
          const normalizedPath = mod.path
            .replace(/^[/\\]/, "")
            .replace(/\\/g, "/");
          const fullPath = path.join(workspace.localPath, normalizedPath);
          try {
            const stat = await fs.stat(fullPath);
            return { mod, normalizedPath, isDir: stat.isDirectory() };
          } catch {
            return { mod, normalizedPath, isDir: false };
          }
        }),
      );
      for (const r of results) classified.push(r);
    }

    // Process non-directory modifications (the vast majority). A path that
    // doesn't exist on disk passes through as-is: it is a deleted file.
    for (const { mod, isDir } of classified) {
      if (!isDir) {
        push(mod);
      }
    }

    // Process directory modifications
    const walkDir = async (dir: string): Promise<void> => {
      const dirFull = path.join(workspace.localPath, dir);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dirFull, { withFileTypes: true });
      } catch {
        return;
      }
      const subdirs: string[] = [];
      for (const entry of entries) {
        const childRelative = dir ? `${dir}/${entry.name}` : entry.name;
        if (childRelative.startsWith(".checkpoint")) continue;
        // Never submitted: the server would read a backslash as a separator.
        if (unsupportedNameReason(entry.name)) continue;
        if (isIgnoredOrHidden(ignoreCache, childRelative, entry.isDirectory()))
          continue;

        if (entry.isDirectory()) {
          subdirs.push(childRelative);
        } else {
          push({ delete: false, path: childRelative });
        }
      }
      // Walk subdirectories in parallel
      await Promise.all(subdirs.map((sub) => walkDir(sub)));
    };

    for (const { normalizedPath, isDir } of classified) {
      if (!isDir) continue;

      await walkDir(normalizedPath);

      // Also check for deleted files (in state.json but not on disk)
      if (workspaceState) {
        const deletedChecks = this.getPathIndex(workspace.id)
          .filesUnder(normalizedPath)
          .map((normalized) => ({
            normalized,
            fileFull: path.join(workspace.localPath, normalized),
          }));
        // Check existence in parallel batches
        for (let i = 0; i < deletedChecks.length; i += CONCURRENCY) {
          const batch = deletedChecks.slice(i, i + CONCURRENCY);
          const exists = await Promise.all(
            batch.map(async ({ fileFull }) => existsSync(fileFull)),
          );
          for (let j = 0; j < batch.length; j++) {
            if (!exists[j]) {
              push({ delete: true, path: batch[j].normalized });
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Reloads the workspace state from disk. Call this after pull/sync operations.
   */
  public async reloadWorkspaceState(
    workspace: Workspace,
    changedPaths?: string[],
  ): Promise<void> {
    // When the operation says exactly which paths it touched and the watcher
    // is keeping the pending-changes cache current, re-check just those paths
    // (plus whatever was already dirty) on the next refresh instead of walking
    // the whole workspace. The watcher replays whatever else changed on disk
    // during the operation (see endVcsOperation); these cover paths whose
    // baseline changed while the file on disk did not.
    const pendingDirty = this.dirtyFiles.get(workspace.id);
    const keepCache =
      changedPaths !== undefined &&
      this.watchers.has(workspace.id) &&
      pendingDirty !== undefined &&
      this.workspacePendingChanges.has(workspace.id) &&
      pendingDirty.size + changedPaths.length <=
        DaemonManager.INCREMENTAL_DIRTY_THRESHOLD;

    await this.loadWorkspaceState(workspace);

    if (keepCache) {
      const dirty = this.dirtyFiles.get(workspace.id)!;
      for (const p of pendingDirty!) dirty.add(p);
      for (const p of changedPaths!) dirty.add(p);
      return;
    }

    // Clear pending changes cache to force recalculation
    this.workspacePendingChanges.delete(workspace.id);
  }

  /**
   * Gets the cached workspace state for a workspace.
   */
  public getWorkspaceState(workspaceId: string): WorkspaceState | null {
    return this.workspaceStates.get(workspaceId) ?? null;
  }

  /**
   * Gets the relative path from workspace root (normalized with forward slashes).
   */
  private getRelativePath(workspace: Workspace, fullPath: string): string {
    // Only Windows uses backslashes as separators; elsewhere one is part of
    // a file name (see unsupportedNameReason).
    return toRelativeRepoPath(path.relative(workspace.localPath, fullPath));
  }

  // ─── Tracked Directory Helpers ──────────────────────────────────────

  /**
   * The workspace's path index (tracked files by directory, and by id),
   * built lazily from its state and dropped whenever tracked paths or the
   * marked-for-add set change.
   */
  private getPathIndex(workspaceId: string): PathIndex {
    let index = this.pathIndexes.get(workspaceId);
    if (!index) {
      const state = this.workspaceStates.get(workspaceId);
      index = new PathIndex(state?.files ?? {}, state?.markedForAdd ?? []);
      this.pathIndexes.set(workspaceId, index);
    }
    return index;
  }

  /**
   * Directories that hold tracked files or the ancestors of marked-for-add
   * paths (the root always counts). Used to prune untracked subtrees.
   */
  private getTrackedDirSet(workspaceId: string): { has(dir: string): boolean } {
    const index = this.getPathIndex(workspaceId);
    return { has: (dir: string) => index.hasTrackedDir(dir) };
  }

  // ─── Change Detection Helper ───────────────────────────────────────

  /**
   * Checks whether a single file has changed relative to the baseline and
   * returns the pending {@link File} entry, or `null` when unchanged / skipped.
   * Shared by both full and incremental refresh paths.
   */
  private async detectFileChange(
    workspace: Workspace,
    relativePath: string,
    stat: Stats,
    baselineFile: WorkspaceStateFile | undefined,
    checkedOutIds: Set<string>,
    markedForAdd: Set<string>,
  ): Promise<File | null> {
    let hasChanged = false;
    let needsHashCheck = false;

    // See util/baseline.ts for the rule and why it is what it is.
    const verdict = compareWithBaseline(stat, baselineFile, {
      whenUnknowable: "unchanged",
    });
    hasChanged = verdict === "changed";
    needsHashCheck = verdict === "compare-hash";

    if (needsHashCheck && baselineFile) {
      const fullPath = path
        .join(workspace.localPath, relativePath)
        .replace(/\\/g, "/");
      const currentHash = await hashFileMD5(fullPath);
      hasChanged = currentHash !== baselineFile.md5;
    }

    // A mode-only change (chmod +x) is a change on Linux and macOS, where the
    // bit is real and is submitted with the file. Windows has no such bit, so
    // a mode set with pending.setExecutable stands in for it there.
    let modeNow: number | undefined;
    if (process.platform === "win32") {
      modeNow = this.workspaceStates.get(workspace.id)?.pendingModes?.[
        relativePath
      ];
    } else if (baselineFile?.mode !== undefined) {
      modeNow = stat.mode & 0o777;
    }
    // A file new to the repo is submitted from Windows as 0644 unless set.
    const baseMode = baselineFile
      ? (baselineFile.mode ?? 0o644)
      : process.platform === "win32"
        ? 0o644
        : undefined;
    const executableChange =
      baseMode !== undefined &&
      modeNow !== undefined &&
      ((modeNow & 0o111) !== 0) !== ((baseMode & 0o111) !== 0)
        ? (modeNow & 0o111) !== 0
        : undefined;
    if (
      !hasChanged &&
      baseMode !== undefined &&
      modeNow !== undefined &&
      modeNow !== baseMode
    ) {
      hasChanged = true;
    }

    if (!hasChanged) return null;

    const isCheckedOut = baselineFile
      ? checkedOutIds.has(baselineFile.fileId)
      : false;

    let status: FileStatus;
    if (!baselineFile) {
      status = markedForAdd.has(relativePath)
        ? FileStatus.Added
        : FileStatus.Local;
    } else if (
      !isBinaryFile(
        relativePath,
        await getBinaryExtensions(workspace.daemonId, workspace.repoId),
      )
    ) {
      const fullPath = path.join(workspace.localPath, relativePath);
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        if (hasConflictMarkers(content)) {
          status = FileStatus.MergeConflict;
        } else {
          status = isCheckedOut
            ? FileStatus.ChangedCheckedOut
            : FileStatus.ChangedNotCheckedOut;
        }
      } catch {
        status = isCheckedOut
          ? FileStatus.ChangedCheckedOut
          : FileStatus.ChangedNotCheckedOut;
      }
    } else {
      status = isCheckedOut
        ? FileStatus.ChangedCheckedOut
        : FileStatus.ChangedNotCheckedOut;
    }

    return {
      path: relativePath,
      type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      status,
      id: baselineFile?.fileId ?? null,
      changelist: baselineFile?.changelist ?? null,
      claims: [],
      staged: false,
      ...(executableChange !== undefined && { executableChange }),
    };
  }

  // ─── Checkout-Only Helpers ─────────────────────────────────────────

  /**
   * Adds unchanged-but-checked-out files to the result set.
   * Shared by both full and incremental refresh paths.
   */
  private async addCheckoutOnlyFiles(
    workspace: Workspace,
    baselineState: WorkspaceState,
    result: WorkspacePendingChanges,
    claims: FileClaimInfo[],
  ): Promise<void> {
    const changedFileIds = new Set(
      Object.values(result.files)
        .map((f) => f.id)
        .filter(Boolean),
    );

    const index = this.getPathIndex(workspace.id);
    for (const claim of claims) {
      if (!changedFileIds.has(claim.fileId)) {
        const claimedPath = index.pathOf(claim.fileId);
        const baselineFile =
          claimedPath !== undefined
            ? baselineState.files[claimedPath]
            : undefined;

        if (claimedPath !== undefined && baselineFile) {
          const relativePath = claimedPath;
          const fullPath = path.join(workspace.localPath, relativePath);

          if (existsSync(fullPath)) {
            const stat = await fs.lstat(fullPath);
            result.files[relativePath] = {
              path: relativePath,
              type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
              status: FileStatus.NotChangedCheckedOut,
              id: claim.fileId,
              changelist: baselineFile.changelist,
              claims: [claim],
              staged: false,
            };
            result.numChanges++;
          }
        }
      }
    }
  }

  // ─── Refresh Dispatcher ────────────────────────────────────────────

  public async refreshWorkspaceContents(
    workspace: Workspace,
    options?: { forceFullRefresh?: boolean },
  ): Promise<WorkspacePendingChanges> {
    const forceFullRefresh = options?.forceFullRefresh ?? false;

    // Get baseline state from state.json
    let baselineState = this.workspaceStates.get(workspace.id);
    if (!baselineState) {
      await this.loadWorkspaceState(workspace);
      baselineState = this.workspaceStates.get(workspace.id)!;
    }

    // Ensure any dirty ignore/hidden files are processed before choosing the
    // refresh strategy.  The watcher callback is async (fire-and-forget) so
    // its ignore-cache update may still be in-flight when a refresh is
    // requested.  Processing them here guarantees the cache is current.
    const dirty = this.dirtyFiles.get(workspace.id);
    if (dirty) {
      // A single rescan covers every dirty ignore file, so only look for the
      // first one (a pull can dirty hundreds at once).
      const changedIgnoreFile = [...dirty].find((dirtyPath) => {
        const baseName = path.basename(dirtyPath);
        return baseName === IGNORE_FILE || baseName === HIDDEN_FILE;
      });

      if (changedIgnoreFile) {
        await this.handleIgnoreFileChange(workspace, changedIgnoreFile);
        this.workspacePendingChanges.delete(workspace.id);
      }
    }

    // The cache is only as current as the watcher's reports. With no watcher
    // running (never started, or failed and not yet restarted) nothing tells
    // the daemon what changed on disk, so an empty dirty set proves nothing
    // and the cache cannot be trusted: rescan.
    const cached = this.watchers.has(workspace.id)
      ? this.workspacePendingChanges.get(workspace.id)
      : undefined;

    // Fast path: nothing changed since last refresh – return cached result
    if (!forceFullRefresh && cached && dirty && dirty.size === 0) {
      Logger.debug(
        `[DaemonManager] No dirty files for workspace ${workspace.name}, returning cached result`,
      );
      return cached;
    }

    // Incremental path: small number of dirty files with an existing cache
    if (
      !forceFullRefresh &&
      cached &&
      dirty &&
      dirty.size > 0 &&
      dirty.size <= DaemonManager.INCREMENTAL_DIRTY_THRESHOLD
    ) {
      Logger.debug(
        `[DaemonManager] Incremental refresh for workspace ${workspace.name} (${dirty.size} dirty files)`,
      );
      const pathKey = await workspacePathKey(workspace.localPath);
      // A path that is another spelling of a tracked file or directory (a
      // rename by case in Explorer or Finder, say) needs the full scan's
      // folded comparison; the incremental one would take a renamed
      // directory for an untracked one.
      const trackedDirs = this.getTrackedDirSet(workspace.id);
      const needsFoldedScan =
        pathKey !== null &&
        [...dirty].some((p) => {
          if (baselineState.files[p] || trackedDirs.has(p)) return false;
          const key = pathKey(p);
          return Object.keys(baselineState.files).some((s) => {
            if (s === p || s.startsWith(p + "/")) return false;
            const k = pathKey(s);
            return k === key || k.startsWith(key + "/");
          });
        });
      if (!needsFoldedScan) {
        return this.incrementalRefresh(workspace, baselineState, cached, dirty);
      }
    }

    // Full refresh with tracked-directory optimisation
    Logger.debug(
      `[DaemonManager] Full refresh for workspace ${workspace.name}` +
        (dirty ? ` (${dirty.size} dirty files)` : ""),
    );
    return this.fullRefresh(workspace, baselineState);
  }

  // ─── Full Refresh ──────────────────────────────────────────────────

  /**
   * Performs a complete filesystem walk of the workspace. Directories that
   * contain no tracked files (and no marked-for-add files) are represented
   * as directory-level entries with {@link FileStatus.Local} rather than
   * walking their contents – the subtree is only enumerated at submit time
   * or when the user expands the directory in the pending-changes UI.
   */
  private async fullRefresh(
    workspace: Workspace,
    baselineState: WorkspaceState,
  ): Promise<WorkspacePendingChanges> {
    const result: WorkspacePendingChanges = {
      numChanges: 0,
      files: {},
    };

    const trackedDirs = this.getTrackedDirSet(workspace.id);
    const ignoreCache = this.getIgnoreCache(workspace.id);
    const markedForAdd = this.getMarkedForAdd(workspace.id);

    // On a volume that takes two spellings for one file (volume.ts), the
    // state's spelling and the one on disk can differ: the tree may spell a
    // directory two ways ("Content/Maps" and "content/maps") while disk has
    // one directory, or hold two spellings of one file. Compare by key there.
    const pathKey = await workspacePathKey(workspace.localPath);
    /** Each tracked directory's key, with the spellings the state has for it. */
    let trackedDirKeys: Map<string, Set<string>> | null = null;
    if (pathKey) {
      trackedDirKeys = new Map();
      for (const p of Object.keys(baselineState.files)) {
        for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) {
          const dir = p.slice(0, i);
          const key = pathKey(dir);
          const spellings = trackedDirKeys.get(key);
          if (spellings) spellings.add(dir);
          else trackedDirKeys.set(key, new Set([dir]));
        }
      }
    }
    const stateByKey = pathKey
      ? groupByKey(Object.keys(baselineState.files), pathKey)
      : null;
    const pendingDirKeys = pathKey
      ? new Set((baselineState.pendingDirRenames ?? []).map(pathKey))
      : null;
    /**
     * Whether disk spells one of a tracked file's directories differently
     * because the user renamed it (Explorer, Finder). Disk has one directory
     * whatever the state calls it, so a different spelling is the user's
     * only where the state has one spelling for it: where the tree spells it
     * two ways, disk can only match one of them. A pull that could not
     * rename it yet (pendingDirRenames) and a difference in normalization
     * alone (HFS+ lists every name decomposed) are not renames either.
     */
    const dirRenamedOnDisk = (diskPath: string, trackedPath: string) => {
      const disk = diskPath.split("/");
      const tracked = trackedPath.split("/");
      for (let i = 0; i < tracked.length - 1; i++) {
        if (disk[i]!.normalize("NFC") === tracked[i]!.normalize("NFC")) {
          continue;
        }
        const key = pathKey!(tracked.slice(0, i + 1).join("/"));
        if (trackedDirKeys!.get(key)?.size === 1 && !pendingDirKeys!.has(key)) {
          return true;
        }
      }
      return false;
    };
    /** Keys of tracked files found on disk under some spelling. */
    const seenTrackedKeys = new Set<string>();

    // Walk recursively, skipping ignored/hidden paths.
    // Untracked directories get a single directory entry instead of recursion.
    // Accumulate every discovered file into one shared array. Pushing into a
    // single accumulator (rather than returning per-directory arrays and
    // merging them with `push(...subResults)`) avoids spreading a huge array as
    // call arguments, which throws "Maximum call stack size exceeded" once the
    // tree is fully tracked and large (tens of thousands of files).
    const diskFiles: Dirent[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      const promises = entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const relativePath = this.getRelativePath(workspace, fullPath);

        if (isIgnoredOrHidden(ignoreCache, relativePath, entry.isDirectory())) {
          return;
        }

        const unsupported = unsupportedNameReason(entry.name);
        if (unsupported) {
          (result.unsupported ??= []).push({
            path: relativePath,
            reason: unsupported,
          });
          return;
        }

        if (entry.isDirectory()) {
          if (
            !trackedDirs.has(relativePath) &&
            !(pathKey && trackedDirKeys!.has(pathKey(relativePath)))
          ) {
            // Untracked directory: add as a single Local entry if it
            // contains at least one non-ignored file (don't recurse into it).
            if (
              await this.hasNonIgnoredFiles(
                workspace,
                relativePath,
                ignoreCache,
              )
            ) {
              result.files[relativePath] = {
                path: relativePath,
                type: FileType.Directory,
                size: 0,
                modifiedAt: 0,
                status: markedForAdd.has(relativePath)
                  ? FileStatus.Added
                  : FileStatus.Local,
                id: null,
                changelist: null,
                claims: [],
                staged: false,
              };
              result.numChanges++;
            }
            return;
          }
          await walk(fullPath);
        } else {
          diskFiles.push(entry);
        }
      });

      await Promise.all(promises);
    };

    await walk(workspace.localPath);

    // Get checkouts from API for checked-out file status
    const client = await CreateApiClientAuth(workspace.daemonId);
    const checkouts = await client.file.getWorkspaceClaims.query({
      workspaceId: workspace.id,
      repoId: workspace.repoId,
    });
    const checkedOutIds = new Set(checkouts.map((c) => c.fileId));

    // Track which baseline files we've seen (to detect deletions)
    const seenBaselineFiles = new Set<string>();

    // Process all files found on disk
    const promises = diskFiles.map(async (f) => {
      if (f.isDirectory()) return;

      const fullPath = path.join(f.parentPath, f.name);
      const relativePath = this.getRelativePath(workspace, fullPath);

      // Skip the .checkpoint directory (only it: a file named
      // ".checkpointrc" is the user's).
      if (
        relativePath === ".checkpoint" ||
        relativePath.startsWith(".checkpoint/")
      ) {
        return;
      }

      // One file that cannot be read (permissions, or gone since the
      // directory was listed) must not fail the whole scan.
      let stat: Stats;
      try {
        stat = await fs.lstat(fullPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          (result.unsupported ??= []).push({
            path: relativePath,
            reason: `it cannot be read (${code ?? String(err)})`,
          });
        }
        return;
      }
      let trackedPath = relativePath;
      let baselineFile = baselineState.files[relativePath];
      if (!baselineFile && pathKey) {
        // The same file under the state's spelling of its directories. A
        // different spelling of the file name itself, or of a directory the
        // user renamed, is a rename the user made, and shows as one
        // (untracked here, deleted below).
        const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
        const match = stateByKey!
          .get(pathKey(relativePath))
          ?.find(
            (p) =>
              p.slice(p.lastIndexOf("/") + 1) === name &&
              !dirRenamedOnDisk(relativePath, p),
          );
        if (match !== undefined) {
          trackedPath = match;
          baselineFile = baselineState.files[match];
        }
      }

      if (baselineFile) {
        seenBaselineFiles.add(trackedPath);
        if (pathKey) seenTrackedKeys.add(pathKey(trackedPath));
      }

      const pendingFile = await this.detectFileChange(
        workspace,
        trackedPath,
        stat,
        baselineFile,
        checkedOutIds,
        markedForAdd,
      );

      if (pendingFile) {
        result.files[trackedPath] = pendingFile;
        result.numChanges++;
      }
    });

    await Promise.all(promises);

    // Check for deleted files (in baseline but not on disk)
    for (const [stateKey, baselineFile] of Object.entries(
      baselineState.files,
    )) {
      // Normalize key (strip leading slash for compatibility)
      const relativePath = stateKey.replace(/^\//, "");
      // A path this workspace cannot hold (an older daemon recorded it) is
      // missing because it cannot exist here, not because the user deleted
      // it. Reporting it as deleted would let "submit everything" delete it
      // for the team.
      if (!isSafeWorkspacePath(relativePath)) continue;
      // Another tracked spelling of this same file is on disk: the tree
      // holds both, and they are one file here. Not deleted.
      if (
        pathKey &&
        !seenBaselineFiles.has(relativePath) &&
        seenTrackedKeys.has(pathKey(relativePath))
      ) {
        continue;
      }
      if (!seenBaselineFiles.has(relativePath)) {
        result.files[relativePath] = {
          path: relativePath,
          type: FileType.Unknown,
          size: 0,
          modifiedAt: 0,
          status: FileStatus.Deleted,
          id: baselineFile.fileId,
          changelist: baselineFile.changelist,
          claims: [],
          staged: false,
        };
        result.numChanges++;
      }
    }

    // Add unchanged but checked-out files
    await this.addCheckoutOnlyFiles(
      workspace,
      baselineState,
      result,
      checkouts,
    );

    this.attachClaims(result, checkouts as FileClaimInfo[]);
    this.applyStagedFlags(workspace.id, result);
    this.workspacePendingChanges.set(workspace.id, result);

    // Clear dirty files since we just did a full refresh
    this.dirtyFiles.set(workspace.id, new Set());

    return result;
  }

  // ─── Incremental Refresh ───────────────────────────────────────────

  /**
   * Updates the cached pending-changes result by processing only the files
   * that the filesystem watcher reported as changed since the last refresh.
   * Falls back to full refresh behaviour for checkout-only bookkeeping.
   */
  private async incrementalRefresh(
    workspace: Workspace,
    baselineState: WorkspaceState,
    cached: WorkspacePendingChanges,
    dirtyPaths: Set<string>,
  ): Promise<WorkspacePendingChanges> {
    const result: WorkspacePendingChanges = {
      numChanges: cached.numChanges,
      files: { ...cached.files },
    };

    const ignoreCache = this.getIgnoreCache(workspace.id);
    const markedForAdd = this.getMarkedForAdd(workspace.id);
    const trackedDirs = this.getTrackedDirSet(workspace.id);

    // Fetch checkouts from API
    const client = await CreateApiClientAuth(workspace.daemonId);
    const checkouts = await client.file.getWorkspaceClaims.query({
      workspaceId: workspace.id,
      repoId: workspace.repoId,
    });

    // Expand directory-level dirty paths: when a whole directory is
    // reported as changed, include every baseline / cached file beneath it.
    // The index answers "tracked files under this directory" directly, and
    // pending entries are matched by walking their own ancestors, so neither
    // costs a pass over every tracked path per dirty path.
    const pathIndex = this.getPathIndex(workspace.id);
    const expandedDirty = new Set(dirtyPaths);
    for (const dirtyPath of dirtyPaths) {
      for (const filePath of pathIndex.filesUnder(dirtyPath)) {
        expandedDirty.add(filePath);
      }
    }
    for (const filePath of pathsUnderAny(
      Object.keys(cached.files),
      dirtyPaths,
    )) {
      expandedDirty.add(filePath);
    }
    const checkedOutIds = new Set(checkouts.map((c) => c.fileId));

    for (const relativePath of expandedDirty) {
      // Only the .checkpoint directory, as in the full scan: a file named
      // ".checkpointrc" is the user's.
      if (isCheckpointDirPath(relativePath)) continue;

      // Skip ignored / hidden paths. The dirty set has no type information,
      // so probe both the file and the directory form of the path.
      if (isIgnoredOrHidden(ignoreCache, relativePath, true)) {
        if (result.files[relativePath]) {
          delete result.files[relativePath];
          result.numChanges--;
        }
        continue;
      }

      const fullPath = path
        .join(workspace.localPath, relativePath)
        .replace(/\\/g, "/");
      const baselineFile = baselineState.files[relativePath];

      // Remove any previous pending-change entry for this file
      if (result.files[relativePath]) {
        delete result.files[relativePath];
        result.numChanges--;
      }

      // Stat the file
      let stat: Stats | null = null;
      try {
        stat = await fs.lstat(fullPath);
        // Directories are handled as directory-level entries, not files
        if (stat.isDirectory()) {
          // If this directory is untracked and has non-ignored children,
          // ensure it appears as a Local directory entry. Collapse to the
          // topmost untracked ancestor so a change deep inside an untracked
          // subtree reports `Saved` rather than `Saved/Config/CrashReports/…`,
          // matching what a full refresh would have produced.
          if (!trackedDirs.has(relativePath)) {
            const dirEntry =
              this.findTopmostUntrackedDir(relativePath, trackedDirs) ??
              relativePath;
            if (!result.files[dirEntry]) {
              if (
                await this.hasNonIgnoredFiles(workspace, dirEntry, ignoreCache)
              ) {
                result.files[dirEntry] = {
                  path: dirEntry,
                  type: FileType.Directory,
                  size: 0,
                  modifiedAt: 0,
                  status: markedForAdd.has(dirEntry)
                    ? FileStatus.Added
                    : FileStatus.Local,
                  id: null,
                  changelist: null,
                  claims: [],
                  staged: false,
                };
                result.numChanges++;
              }
            }
          }
          continue;
        }
      } catch {
        // File does not exist
      }

      if (!stat) {
        // File deleted (or is a directory). A path this workspace cannot
        // hold is missing for that reason, not deleted (see the full scan).
        if (baselineFile && isSafeWorkspacePath(relativePath)) {
          result.files[relativePath] = {
            path: relativePath,
            type: FileType.Unknown,
            size: 0,
            modifiedAt: 0,
            status: FileStatus.Deleted,
            id: baselineFile.fileId,
            changelist: baselineFile.changelist,
            claims: [],
            staged: false,
          };
          result.numChanges++;
        }
        continue;
      }

      // For untracked files in untracked directories, ensure the topmost
      // untracked ancestor directory appears as a Local directory entry
      // instead of adding the individual file.
      if (!baselineFile && !markedForAdd.has(relativePath)) {
        const topmostDir = this.findTopmostUntrackedDir(
          relativePath,
          trackedDirs,
        );
        if (topmostDir) {
          // Add the topmost untracked ancestor (if not already present)
          if (!result.files[topmostDir]) {
            if (
              await this.hasNonIgnoredFiles(workspace, topmostDir, ignoreCache)
            ) {
              result.files[topmostDir] = {
                path: topmostDir,
                type: FileType.Directory,
                size: 0,
                modifiedAt: 0,
                status: FileStatus.Local,
                id: null,
                changelist: null,
                claims: [],
                staged: false,
              };
              result.numChanges++;
            }
          }
          continue; // Don't add the individual file
        }
      }

      const pendingFile = await this.detectFileChange(
        workspace,
        relativePath,
        stat,
        baselineFile,
        checkedOutIds,
        markedForAdd,
      );

      if (pendingFile) {
        result.files[relativePath] = pendingFile;
        result.numChanges++;
      }
    }

    // Refresh checkout-only entries: remove stale ones
    for (const [filePath, file] of Object.entries(result.files)) {
      if (file.status === FileStatus.NotChangedCheckedOut) {
        if (!file.id || !checkedOutIds.has(file.id)) {
          delete result.files[filePath];
          result.numChanges--;
        }
      }
    }

    // Add new checkout-only files
    await this.addCheckoutOnlyFiles(
      workspace,
      baselineState,
      result,
      checkouts,
    );

    this.attachClaims(result, checkouts as FileClaimInfo[]);
    this.applyStagedFlags(workspace.id, result);
    this.workspacePendingChanges.set(workspace.id, result);
    this.dirtyFiles.set(workspace.id, new Set());

    return result;
  }

  /**
   * Starts (or restarts) the filesystem watcher for a workspace. Returns
   * whether a watcher is now running.
   */
  public watchWorkspace(workspace: Workspace): boolean {
    this.cancelWatcherRetry(workspace.id);

    // Check if the workspace path exists before watching
    if (!existsSync(workspace.localPath)) {
      Logger.warn(
        `[DaemonManager] Workspace path does not exist, skipping watch: ${workspace.localPath}`,
      );
      return false;
    }

    // Close existing watcher if any
    const existingWatcher = this.watchers.get(workspace.id);
    if (existingWatcher) {
      existingWatcher.close();
      this.watchers.delete(workspace.id);
    }

    let watcher: FSWatcher;
    try {
      watcher = watch(
        workspace.localPath,
        { recursive: true },
        (eventType, filename) => {
          void this.handleWatchEvent(workspace, eventType, filename);
        },
      );
    } catch (err) {
      // fs.watch can throw instead of emitting "error": ENOSPC on Linux when
      // the inotify watch limit is reached, EPERM or EACCES on a directory it
      // may not read. Uncaught, this failed registration (and, from a retry
      // timer, crashed the daemon). Treat it like a watcher error.
      this.handleWatchError(workspace, err);
      return false;
    }

    watcher.on("error", (err) => {
      // A watcher that was already replaced must not tear down its successor.
      if (this.watchers.get(workspace.id) !== watcher) return;
      this.handleWatchError(workspace, err);
    });

    this.watchers.set(workspace.id, watcher);
    // Nothing reported the changes made while no watcher ran (before this
    // one started, or between a failed watcher and this restart), so a
    // pending list cached before now cannot be trusted.
    this.workspacePendingChanges.delete(workspace.id);
    return true;
  }

  /**
   * Applies one filesystem watcher event: marks the path dirty for the next
   * incremental refresh, buffers it during a VCS operation, or drops the
   * cached pending list when the event says changes went unreported.
   * Public so tests can feed it events the OS cannot be made to produce on
   * demand (an overflowed change buffer).
   */
  public async handleWatchEvent(
    workspace: Workspace,
    eventType: string,
    filename: string | Buffer | null,
  ): Promise<void> {
    if (!filename) {
      // No name is how Windows reports an overflowed change buffer (many
      // files changed at once: a build, a level save). Some changes were
      // not reported, so the cached pending list cannot be trusted: drop
      // it, and the next refresh rescans.
      this.workspacePendingChanges.delete(workspace.id);
      return;
    }

    const relativePath = toRelativeRepoPath(filename.toString());

    // Skip the .checkpoint directory (only it, as in the full scan: a file
    // named ".checkpointrc" is the user's).
    if (isCheckpointDirPath(relativePath)) {
      return;
    }

    // During VCS operations (pull/submit/merge) buffer events instead
    // of marking dirty. This prevents mid-operation queries from seeing
    // transient false pending-changes, while still capturing legitimate
    // user edits that happen concurrently (e.g. editing file D while
    // pulling files A, B, C). Buffered events are replayed in
    // endVcsOperation() after the baseline state is reloaded.
    if (this.vcsOperationActive.get(workspace.id)) {
      const buffer = this.vcsBufferedEvents.get(workspace.id);
      if (buffer) {
        buffer.add(relativePath);
      } else {
        // No buffer to replay from: the event would be lost.
        this.workspacePendingChanges.delete(workspace.id);
      }
      return;
    }

    Logger.debug(
      `[DaemonManager] Detected change in workspace ${workspace.name} (${eventType} on ${relativePath})`,
    );

    const dirty = this.dirtyFiles.get(workspace.id);

    // If an ignore/hidden file changed, rebuild the cached patterns
    // and force a full refresh so new ignore rules take effect. The path is
    // marked dirty first, so a refresh that runs while the rescan is in
    // flight sees the change and rescans the ignore files itself.
    const baseName = path.basename(relativePath);
    if (baseName === IGNORE_FILE || baseName === HIDDEN_FILE) {
      dirty?.add(relativePath);
      try {
        await this.handleIgnoreFileChange(workspace, relativePath);
      } catch (err) {
        Logger.warn(
          `[DaemonManager] Could not rescan ignore files for workspace ${workspace.name}: ${(err as Error).message}`,
        );
      }
      this.workspacePendingChanges.delete(workspace.id);
      return;
    }

    // An ignored or hidden path never shows as pending (the incremental
    // refresh skips it with the same test), so marking it dirty only costs:
    // a build writing thousands of files into Intermediate/ would push the
    // dirty set past the incremental threshold and force full rescans. A
    // change to the ignore rules drops the cache, so a path these rules
    // ignore but new ones would not is still picked up by the rescan.
    if (
      isIgnoredOrHidden(this.getIgnoreCache(workspace.id), relativePath, true)
    ) {
      return;
    }

    // Mark file as dirty for incremental refresh
    dirty?.add(relativePath);
  }

  /**
   * Handles a failed watcher: drops the cached pending list (changes made
   * while no watcher runs are never reported) and schedules a restart.
   * Public so tests can simulate a failure (Linux out of inotify watches).
   */
  public handleWatchError(workspace: Workspace, err: unknown): void {
    Logger.warn(
      `[DaemonManager] Watcher error for workspace ${workspace.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    this.workspacePendingChanges.delete(workspace.id);

    // Remove the broken watcher and try to re-establish after a short delay.
    // The directory may have been temporarily removed (e.g. test cleanup).
    const broken = this.watchers.get(workspace.id);
    this.watchers.delete(workspace.id);
    try {
      broken?.close();
    } catch {
      // Already closed by the failure
    }
    this.scheduleWatcherRetry(workspace, 0);
  }

  /** Whether a filesystem watcher is currently running for the workspace. */
  public isWatching(workspaceId: string): boolean {
    return this.watchers.has(workspaceId);
  }

  private scheduleWatcherRetry(workspace: Workspace, attempt: number): void {
    if (this.watcherRetries.has(workspace.id)) return;
    const delay = Math.min(
      DaemonManager.watcherRetryMs * 2 ** attempt,
      DaemonManager.WATCHER_RETRY_MAX_MS,
    );
    const timer = setTimeout(() => {
      this.watcherRetries.delete(workspace.id);
      // Unlinked (or shut down) in the meantime, or already watched again.
      if (!this.findWorkspaceById(workspace.id)) return;
      if (this.watchers.has(workspace.id)) return;
      // Retried once and gave up before, so a workspace whose directory was
      // still missing after 5 s went unwatched until the daemon restarted.
      if (!this.watchWorkspace(workspace)) {
        // A throwing watch() has already scheduled attempt 0; back off instead.
        this.cancelWatcherRetry(workspace.id);
        this.scheduleWatcherRetry(workspace, attempt + 1);
      }
    }, delay);
    // A pending restart must not keep the process alive on its own.
    timer.unref?.();
    this.watcherRetries.set(workspace.id, timer);
  }

  private cancelWatcherRetry(workspaceId: string): void {
    const timer = this.watcherRetries.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.watcherRetries.delete(workspaceId);
    }
  }

  /**
   * Gets the set of files that have changed since the last full refresh.
   * Useful for UI to show which files may need attention.
   */
  public getDirtyFiles(workspaceId: string): Set<string> {
    return this.dirtyFiles.get(workspaceId) ?? new Set();
  }

  /**
   * Checks if a workspace has any pending dirty files that haven't been processed.
   */
  public hasDirtyFiles(workspaceId: string): boolean {
    const dirty = this.dirtyFiles.get(workspaceId);
    return dirty ? dirty.size > 0 : false;
  }

  /**
   * Stamps the staged flag onto a freshly computed pending-changes result.
   *
   * Done in one place rather than at each of the ~10 File construction sites,
   * so a new site cannot silently forget it.
   */
  /**
   * Gives each pending file this workspace's claims on it. Staging claims a
   * file onto the branch it is staged to, and the submit endpoint (like the
   * desktop's bucket view) sends a file to the branch its claim names, so a
   * changed file listed with no claims always went to the domain root and a
   * feature-branch submit found nothing to send (the gate).
   */
  private attachClaims(
    result: WorkspacePendingChanges,
    claims: FileClaimInfo[],
  ): void {
    if (claims.length === 0) return;
    const byFileId = new Map<string, FileClaimInfo[]>();
    const byPath = new Map<string, FileClaimInfo[]>();
    for (const claim of claims) {
      const id = byFileId.get(claim.fileId);
      if (id) id.push(claim);
      else byFileId.set(claim.fileId, [claim]);
      const p = byPath.get(claim.filePath);
      if (p) p.push(claim);
      else byPath.set(claim.filePath, [claim]);
    }
    for (const file of Object.values(result.files)) {
      if (file.claims.length > 0) continue;
      const found =
        (file.id ? byFileId.get(file.id) : undefined) ?? byPath.get(file.path);
      if (found) file.claims = found;
    }
  }

  private applyStagedFlags(
    workspaceId: string,
    result: WorkspacePendingChanges,
  ): void {
    const staged = this.getStaged(workspaceId);
    for (const [relativePath, file] of Object.entries(result.files)) {
      file.staged = staged.has(relativePath);
    }
  }

  /**
   * Returns the set of relative paths staged for the next submit.
   *
   * Staging is the git index: whether a change is ready to go into its
   * branch's next changelist. Which branch that is comes from the file's
   * claim on the server, not from here, so the two cannot drift.
   */
  public getStaged(workspaceId: string): Set<string> {
    const state = this.workspaceStates.get(workspaceId);
    return new Set(state?.staged ?? []);
  }

  /** Stage one or more files for the next submit. Persists to workspace state. */
  public async stage(
    workspace: Workspace,
    relativePaths: string[],
  ): Promise<void> {
    await this.mutateStaged(workspace, { add: relativePaths });
  }

  /**
   * Unstage one or more files.
   *
   * Deliberately leaves any claim in place: unstaging says "not ready yet",
   * not "I am done with this file". Releasing a claim is a separate act.
   */
  public async unstage(
    workspace: Workspace,
    relativePaths: string[],
  ): Promise<void> {
    await this.mutateStaged(workspace, { remove: relativePaths });
  }

  private async mutateStaged(
    workspace: Workspace,
    change: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const state = this.workspaceStates.get(workspace.id);
    if (!state) return;

    await this.persistDelta(workspace, { staged: change });

    // Invalidate so the next refresh reports the new staged flags.
    this.invalidatePendingPaths(workspace.id, [
      ...(change.add ?? []),
      ...(change.remove ?? []),
    ]);
  }

  /**
   * Returns the set of relative paths currently marked for add in a workspace.
   */
  public getMarkedForAdd(workspaceId: string): Set<string> {
    const state = this.workspaceStates.get(workspaceId);
    return new Set(state?.markedForAdd ?? []);
  }

  /**
   * Mark one or more files for add. Persists to state.json.
   */
  public async markForAdd(
    workspace: Workspace,
    relativePaths: string[],
  ): Promise<void> {
    const state = this.workspaceStates.get(workspace.id);
    if (!state) return;

    await this.persistDelta(workspace, {
      markedForAdd: { add: relativePaths },
    });

    // Invalidate caches so next refresh picks up the new status. Marking
    // changes which directories count as tracked, which changes how untracked
    // folders collapse, so this needs a full refresh rather than a re-check.
    this.workspacePendingChanges.delete(workspace.id);
    this.pathIndexes.delete(workspace.id);
  }

  /**
   * Remove one or more files from the marked-for-add list. Persists to state.json.
   */
  public async unmarkForAdd(
    workspace: Workspace,
    relativePaths: string[],
  ): Promise<void> {
    const state = this.workspaceStates.get(workspace.id);
    if (!state) return;

    await this.persistDelta(workspace, {
      markedForAdd: { remove: relativePaths },
    });

    // Invalidate caches so next refresh picks up the new status. Marking
    // changes which directories count as tracked, which changes how untracked
    // folders collapse, so this needs a full refresh rather than a re-check.
    this.workspacePendingChanges.delete(workspace.id);
    this.pathIndexes.delete(workspace.id);
  }

  /**
   * Makes files executable or not in their next submit, as git's
   * `update-index --chmod=+x` does. On Linux and macOS that is the file's own
   * mode, so this changes it on disk. Windows has no executable bit, so the
   * mode is kept in the state (WorkspaceState.pendingModes) and sent with the
   * file's next submit. Either way the file then shows as modified.
   *
   * Returns the mode each file will be submitted with.
   */
  public async setExecutable(
    workspace: Workspace,
    relativePaths: string[],
    executable: boolean,
  ): Promise<{ path: string; mode: number }[]> {
    const toggle = (mode: number) =>
      executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
    const state =
      this.workspaceStates.get(workspace.id) ??
      (await getWorkspaceState(workspace.localPath, this.stateBackend));

    const targets: { path: string; full: string }[] = [];
    for (const relativePath of relativePaths) {
      const full = resolveInWorkspace(workspace.localPath, relativePath);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isFile()) {
        throw new Error(`${relativePath} is not a file in this workspace`);
      }
      targets.push({ path: relativePath, full });
    }

    const result: { path: string; mode: number }[] = [];
    if (process.platform !== "win32") {
      for (const { path: p, full } of targets) {
        const mode = toggle((await fs.stat(full)).mode & 0o777);
        await fs.chmod(full, mode);
        result.push({ path: p, mode });
      }
    } else {
      const next = { ...(state.pendingModes ?? {}) };
      for (const { path: p } of targets) {
        // A file new to the repo is submitted as 0644 unless set.
        const base = state.files[p]?.mode ?? 0o644;
        const mode = toggle(next[p] ?? base);
        if (mode === base) delete next[p];
        else next[p] = mode;
        result.push({ path: p, mode });
      }
      await this.persistDelta(workspace, { meta: { pendingModes: next } });
    }

    // On Windows nothing on disk changed for the watcher to notice.
    this.workspacePendingChanges.delete(workspace.id);
    return result;
  }

  /** Forgets modes set with setExecutable for these files (a revert). */
  public async dropPendingModes(
    workspace: Workspace,
    relativePaths: string[],
  ): Promise<void> {
    const current = this.workspaceStates.get(workspace.id)?.pendingModes;
    if (!current || !relativePaths.some((p) => p in current)) return;
    const next = { ...current };
    for (const p of relativePaths) delete next[p];
    await this.persistDelta(workspace, { meta: { pendingModes: next } });
    this.workspacePendingChanges.delete(workspace.id);
  }

  /**
   * Records that tracked files were just rewritten with their baseline
   * content (a revert), so their recorded size and mtime describe the file
   * that is now on disk.
   *
   * Change detection treats "same size, written since the baseline, no hash
   * to compare" as changed, because it cannot prove otherwise. Anything that
   * rewrites a tracked file with the content it is tracked at has to say so
   * here, or the file goes on showing as modified.
   */
  public async markFilesPristine(
    workspace: Workspace,
    relativePaths: string[],
  ): Promise<void> {
    const state = this.workspaceStates.get(workspace.id);
    if (!state || relativePaths.length === 0) return;

    const upsert: Record<string, WorkspaceState["files"][string]> = {};
    for (const relativePath of relativePaths) {
      const entry = state.files[relativePath];
      if (!entry) continue;
      try {
        const stat = await fs.stat(
          path.join(workspace.localPath, relativePath),
        );
        upsert[relativePath] = {
          ...entry,
          size: stat.size,
          mtime: stat.mtimeMs,
          md5: "",
        };
      } catch {
        // Not on disk; nothing to record.
      }
    }
    if (Object.keys(upsert).length === 0) return;

    await this.persistDelta(workspace, { files: { upsert } });
    this.invalidatePendingPaths(workspace.id, Object.keys(upsert));
  }

  /**
   * Marks `paths` for re-checking on the next refresh. With the watcher
   * keeping the pending-changes cache current, only those paths are looked
   * at again; otherwise the cache is dropped and the next refresh is full.
   */
  private invalidatePendingPaths(workspaceId: string, paths: string[]): void {
    const dirty = this.dirtyFiles.get(workspaceId);
    if (
      this.watchers.has(workspaceId) &&
      dirty &&
      this.workspacePendingChanges.has(workspaceId) &&
      dirty.size + paths.length <= DaemonManager.INCREMENTAL_DIRTY_THRESHOLD
    ) {
      for (const p of paths) dirty.add(p);
      return;
    }
    this.workspacePendingChanges.delete(workspaceId);
  }

  /**
   * Records a change to the workspace's state, writing only what changed,
   * and keeps the manager's copy pointing at the current shared state.
   */
  private async persistDelta(
    workspace: Workspace,
    delta: StateDelta,
  ): Promise<void> {
    await updateWorkspaceState(workspace, delta, this.stateBackend);
    this.workspaceStates.set(
      workspace.id,
      await getWorkspaceState(workspace.localPath, this.stateBackend),
    );
  }

  // ─── VCS Operation Guard ─────────────────────────────────────────

  /** Whether a pull, submit, or merge is running in any workspace. */
  public hasActiveVcsOperation(): boolean {
    return [...this.vcsOperationActive.values()].some(Boolean);
  }

  /**
   * Waits until no VCS operation is running, or `timeoutMs` passes. For a
   * shutdown: a pull that is cut off is recovered on the next start (see
   * interrupted-pull.ts), but one that finishes needs no recovery.
   */
  public async waitForVcsIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.hasActiveVcsOperation()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return true;
  }

  /**
   * Begins buffering file-watcher events for a workspace while a VCS
   * operation (pull, submit, merge) runs. Call this before the operation
   * starts and pair it with {@link endVcsOperation} in a `finally` block.
   */
  public beginVcsOperation(workspaceId: string): void {
    this.vcsOperationActive.set(workspaceId, true);
    this.vcsBufferedEvents.set(workspaceId, new Set());
    Logger.debug(
      `[DaemonManager] VCS operation started for workspace ${workspaceId}, watcher events buffered`,
    );
  }

  /**
   * Re-enables the file watcher after a VCS operation completes.
   *
   * Waits a short grace period to let any in-flight `fs.watch()` events
   * arrive in the buffer, then replays the buffered events into the
   * dirty-files set. The next {@link refreshWorkspaceContents} call will
   * run an incremental refresh against the **new** baseline state (loaded
   * by `reloadWorkspaceState` during the VCS operation). VCS-caused file
   * changes will match the new baseline and be filtered out automatically,
   * while genuine user edits (e.g. editing an unrelated file during a pull)
   * will be detected as actual pending changes.
   */
  public async endVcsOperation(workspaceId: string): Promise<void> {
    // Wait for queued fs.watch() events to arrive in the buffer
    await new Promise((resolve) =>
      setTimeout(resolve, DaemonManager.VCS_GRACE_PERIOD_MS),
    );

    this.vcsOperationActive.set(workspaceId, false);

    // Replay buffered events into dirtyFiles. reloadWorkspaceState()
    // (called by the VCS operation before this method) already cleared
    // dirtyFiles and loaded the updated baseline, so these events will
    // be checked against the post-VCS state on the next refresh.
    const buffered = this.vcsBufferedEvents.get(workspaceId);
    if (buffered && buffered.size > 0) {
      const dirty = this.dirtyFiles.get(workspaceId);
      if (dirty) {
        for (const p of buffered) {
          dirty.add(p);
        }
      }

      // Handle any ignore/hidden file changes that arrived during the VCS
      // operation so the ignore cache stays current. A pull can rewrite many
      // ignore files at once and one rescan covers them all.
      const changedIgnoreFile = [...buffered].find((relativePath) => {
        const baseName = path.basename(relativePath);
        return baseName === IGNORE_FILE || baseName === HIDDEN_FILE;
      });
      if (changedIgnoreFile) {
        const workspace = this.findWorkspaceById(workspaceId);
        if (workspace) {
          await this.handleIgnoreFileChange(workspace, changedIgnoreFile);
        }
      }

      Logger.debug(
        `[DaemonManager] VCS operation ended for workspace ${workspaceId}, replayed ${buffered.size} buffered event(s)`,
      );
    } else {
      Logger.debug(
        `[DaemonManager] VCS operation ended for workspace ${workspaceId}, no buffered events`,
      );
    }

    this.vcsBufferedEvents.delete(workspaceId);
  }

  /**
   * Finds a workspace by its ID across all daemon entries.
   */
  private findWorkspaceById(workspaceId: string): Workspace | undefined {
    for (const [, workspaceList] of this.workspaces) {
      const found = workspaceList.find((w) => w.id === workspaceId);
      if (found) return found;
    }
    return undefined;
  }

  // ─── Sync Status Polling ───────────────────────────────────────────

  /**
   * Starts the periodic sync status polling for all workspaces.
   */
  private startSyncPolling(): void {
    if (this.syncPollInterval) {
      return;
    }

    // Do an initial poll shortly after startup
    setTimeout(() => {
      this.pollAllWorkspaces();
    }, 10_000);

    this.syncPollInterval = setInterval(() => {
      this.pollAllWorkspaces();
    }, DaemonManager.SYNC_POLL_INTERVAL_MS);
  }

  /**
   * Stops sync status polling.
   */
  private stopSyncPolling(): void {
    if (this.syncPollInterval) {
      clearInterval(this.syncPollInterval);
      this.syncPollInterval = null;
    }
  }

  /**
   * Polls sync status for every configured workspace.
   */
  private async pollAllWorkspaces(): Promise<void> {
    for (const [, workspaceList] of this.workspaces) {
      for (const workspace of workspaceList) {
        try {
          await this.refreshSyncStatus(workspace);
        } catch (err) {
          Logger.warn(
            `[DaemonManager] Failed to poll sync status for workspace ${workspace.name}: ${err}`,
          );
        }
      }
    }
  }

  /**
   * Refreshes the sync status for a single workspace by querying the remote.
   */
  public async refreshSyncStatus(workspace: Workspace): Promise<SyncStatus> {
    const status = await checkSyncStatus({
      id: workspace.id,
      repoId: workspace.repoId,
      domainBranchName: workspace.domainBranchName,
      workspaceName: workspace.name,
      localPath: workspace.localPath,
      daemonId: workspace.daemonId,
    });
    this.syncStatuses.set(workspace.id, status);

    // Persist the remote head we checked against so resolveConflicts can
    // detect if the remote moved since the user last saw conflict data.
    try {
      const config = await getWorkspaceConfig(workspace.localPath);
      if (config) {
        config.lastSyncStatusRemoteHead = status.remoteHeadNumber;
        await saveWorkspaceConfig(config);
      }
    } catch (err) {
      Logger.warn(
        `[DaemonManager] Failed to persist lastSyncStatusRemoteHead for ${workspace.name}: ${err}`,
      );
    }

    return status;
  }

  /**
   * Gets the cached sync status for a workspace.
   */
  public getSyncStatus(workspaceId: string): SyncStatus | null {
    return this.syncStatuses.get(workspaceId) ?? null;
  }

  /**
   * Clears the cached sync status for a workspace (e.g. after a pull).
   */
  public clearSyncStatus(workspaceId: string): void {
    this.syncStatuses.delete(workspaceId);
  }
}
