import path from "path";
import { DaemonConfig } from "./daemon-config.js";
import { InitLogger, Logger } from "./logging.js";
import {
  FileStatus,
  FileType,
  type File,
  type Workspace,
  type WorkspacePendingChanges,
} from "./types/index.js";
import { watch, type FSWatcher, promises as fs, existsSync, Dirent } from "fs";
import { CreateApiClientAuth, hashFile } from "@checkpointvcs/common";
import {
  getWorkspaceState,
  saveWorkspaceState,
  getWorkspaceConfig,
  saveWorkspaceConfig,
  type WorkspaceState,
} from "./util/index.js";
import { getFileStatus, getIgnoreCache } from "./file-status.js";
import { checkSyncStatus, type SyncStatus } from "./util/sync-status.js";
import { hasConflictMarkers } from "./util/auto-merge.js";
import { isBinaryFile } from "./util/read-file.js";

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

  private watchers: Map<string, FSWatcher> = new Map();

  /** Cached sync status per workspace, keyed by workspace.id */
  private syncStatuses: Map<string, SyncStatus> = new Map();

  /** Interval handle for sync polling */
  private syncPollInterval: ReturnType<typeof setInterval> | null = null;

  /** Sync poll interval in milliseconds (5 minutes) */
  private static readonly SYNC_POLL_INTERVAL_MS = 5 * 60 * 1000;

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
    for (const workspace of config.workspaces) {
      const existing = this.workspaces.get(workspace.daemonId) || [];
      existing.push(workspace);
      this.workspaces.set(workspace.daemonId, existing);

      // Load state.json baseline for each workspace
      await this.loadWorkspaceState(workspace);

      this.watchWorkspace(workspace);
    }

    await InitLogger();

    // Start sync polling for all workspaces
    this.startSyncPolling();
  }

  public async shutdown(): Promise<void> {
    this.stopSyncPolling();
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers.clear();
  }

  /**
   * Loads the workspace state from state.json and caches it.
   */
  private async loadWorkspaceState(workspace: Workspace): Promise<void> {
    const state = await getWorkspaceState(workspace.localPath);
    this.workspaceStates.set(workspace.id, state);
    this.dirtyFiles.set(workspace.id, new Set());
  }

  /**
   * Reloads the workspace state from disk. Call this after pull/sync operations.
   */
  public async reloadWorkspaceState(workspace: Workspace): Promise<void> {
    await this.loadWorkspaceState(workspace);
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
    return path.relative(workspace.localPath, fullPath).replace(/\\/g, "/");
  }

  public async refreshWorkspaceContents(
    workspace: Workspace,
  ): Promise<WorkspacePendingChanges> {
    const result: WorkspacePendingChanges = {
      numChanges: 0,
      files: {},
    };

    // Get baseline state from state.json
    let baselineState = this.workspaceStates.get(workspace.id);
    if (!baselineState) {
      await this.loadWorkspaceState(workspace);
      baselineState = this.workspaceStates.get(workspace.id)!;
    }

    const ignoreCache = await getIgnoreCache(workspace.localPath);

    // walk recursively and gather files, skipping ignored and hidden paths
    const walk = async (dir: string): Promise<Dirent[]> => {
      const results: Dirent[] = [];

      const entries = await fs.readdir(dir, { withFileTypes: true });

      const promises = entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const relativePath = this.getRelativePath(workspace, fullPath);

        if (
          ignoreCache.ignore.ignores(relativePath) ||
          ignoreCache.hidden.ignores(relativePath)
        ) {
          return;
        }

        if (entry.isDirectory()) {
          const subResults = await walk(fullPath);
          results.push(...subResults);
        } else {
          results.push(entry);
        }
      });

      await Promise.all(promises);

      return results;
    };

    const diskFiles = await walk(workspace.localPath);

    // Get checkouts from API for checked-out file status
    const client = await CreateApiClientAuth(workspace.daemonId);
    const checkouts = await client.file.getCheckouts.query({
      workspaceId: workspace.id,
      repoId: workspace.repoId,
    });

    // Track which baseline files we've seen (to detect deletions)
    const seenBaselineFiles = new Set<string>();

    // Get the set of files marked for add
    const markedForAdd = this.getMarkedForAdd(workspace.id);

    // Process all files on disk
    const promises = diskFiles.map(async (f) => {
      if (f.isDirectory()) {
        return;
      }

      const fullPath = path.join(f.parentPath, f.name).replace(/\\/g, "/");
      const relativePath = this.getRelativePath(workspace, fullPath);

      // Skip .checkpoint directory
      if (relativePath.startsWith(".checkpoint")) {
        return;
      }

      const stat = await fs.lstat(fullPath);
      // Look up with and without leading slash for backward compatibility
      const baselineFile = baselineState.files[relativePath];

      if (baselineFile) {
        seenBaselineFiles.add(relativePath);
      }

      const fileStatus = await getFileStatus({
        workspacePath: workspace.localPath,
        relativePath,
        workspaceState: baselineState,
        existsOnDisk: true,
        isDirectory: stat.isDirectory(),
      });

      // Determine if file has changed
      let hasChanged = false;
      let needsHashCheck = false;

      if (
        [
          FileStatus.Unknown,
          FileStatus.NotInWorkspaceRoot,
          FileStatus.Ignored,
          FileStatus.HiddenChanges,
          FileStatus.Artifact,
        ].includes(fileStatus.status)
      ) {
        hasChanged = false;
      } else if (!baselineFile) {
        // File doesn't exist in baseline - it's a new/added file
        hasChanged = true;
      } else if (stat.size !== baselineFile.size) {
        // Size changed - definitely modified
        hasChanged = true;
      } else if (baselineFile.mtime && stat.mtimeMs !== baselineFile.mtime) {
        // Mtime changed but size same - need to verify with hash
        needsHashCheck = true;
      }

      if (needsHashCheck && baselineFile) {
        const currentHash = await hashFile(fullPath);
        hasChanged = currentHash !== baselineFile.hash;
      }

      if (hasChanged) {
        const isCheckedOut = baselineFile
          ? checkouts.some((c) => c.fileId === baselineFile.fileId)
          : false;

        // Check if this is a text file with conflict markers from auto-merge
        let status: FileStatus;
        if (!baselineFile) {
          status = markedForAdd.has(relativePath)
            ? FileStatus.Added
            : FileStatus.Local;
        } else if (!isBinaryFile(relativePath)) {
          // For text files, check if they contain conflict markers
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

        const pendingFile: File = {
          path: relativePath,
          type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          status,
          id: baselineFile?.fileId ?? null,
          changelist: baselineFile?.changelist ?? null,
          checkouts: [],
        };

        result.files[relativePath] = pendingFile;
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
      if (!seenBaselineFiles.has(relativePath)) {
        const pendingFile: File = {
          path: relativePath,
          type: FileType.Unknown,
          size: 0,
          modifiedAt: 0,
          status: FileStatus.Deleted,
          id: baselineFile.fileId,
          changelist: baselineFile.changelist,
          checkouts: [],
        };

        result.files[relativePath] = pendingFile;
        result.numChanges++;
      }
    }

    // Add unchanged but checked-out files
    const changedFileIds = new Set(
      Object.values(result.files)
        .map((f) => f.id)
        .filter(Boolean),
    );

    for (const checkout of checkouts) {
      if (!changedFileIds.has(checkout.fileId)) {
        // Find the path for this fileId in baseline
        const baselineEntry = Object.entries(baselineState.files).find(
          ([, file]) => file.fileId === checkout.fileId,
        );

        if (baselineEntry) {
          const [relativePath, baselineFile] = baselineEntry;
          const fullPath = path.join(workspace.localPath, relativePath);

          if (existsSync(fullPath)) {
            const stat = await fs.lstat(fullPath);
            const pendingFile: File = {
              path: relativePath,
              type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
              status: FileStatus.NotChangedCheckedOut,
              id: checkout.fileId,
              changelist: baselineFile.changelist,
              checkouts: [],
            };

            result.files[relativePath] = pendingFile;
            result.numChanges++;
          }
        }
      }
    }

    this.workspacePendingChanges.set(workspace.id, result);

    // Clear dirty files since we just did a full refresh
    this.dirtyFiles.set(workspace.id, new Set());

    return result;
  }

  public watchWorkspace(workspace: Workspace): void {
    // Check if the workspace path exists before watching
    if (!existsSync(workspace.localPath)) {
      Logger.warn(
        `[DaemonManager] Workspace path does not exist, skipping watch: ${workspace.localPath}`,
      );
      return;
    }

    // Close existing watcher if any
    const existingWatcher = this.watchers.get(workspace.id);
    if (existingWatcher) {
      existingWatcher.close();
    }

    const watcher = watch(
      workspace.localPath,
      { recursive: true },
      async (eventType, filename) => {
        if (!filename) return;

        const relativePath = filename.replace(/\\/g, "/");

        // Skip .checkpoint directory
        if (relativePath.startsWith(".checkpoint")) {
          return;
        }

        Logger.debug(
          `[DaemonManager] Detected change in workspace ${workspace.name} (${eventType} on ${relativePath})`,
        );

        // Mark file as dirty for incremental refresh
        const dirty = this.dirtyFiles.get(workspace.id);
        if (dirty) {
          dirty.add(relativePath);
        }
      },
    );

    this.watchers.set(workspace.id, watcher);
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

    const existing = new Set(state.markedForAdd ?? []);
    for (const p of relativePaths) {
      existing.add(p);
    }
    state.markedForAdd = [...existing];
    await this.persistState(workspace, state);

    // Invalidate pending changes so next refresh picks up the new status
    this.workspacePendingChanges.delete(workspace.id);
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

    const existing = new Set(state.markedForAdd ?? []);
    for (const p of relativePaths) {
      existing.delete(p);
    }
    state.markedForAdd = [...existing];
    await this.persistState(workspace, state);

    // Invalidate pending changes so next refresh picks up the new status
    this.workspacePendingChanges.delete(workspace.id);
  }

  /**
   * Persist the in-memory workspace state back to state.json (and workspace.json).
   */
  private async persistState(
    workspace: Workspace,
    state: WorkspaceState,
  ): Promise<void> {
    await saveWorkspaceState(workspace as any, state);
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
      branchName: workspace.branchName,
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
