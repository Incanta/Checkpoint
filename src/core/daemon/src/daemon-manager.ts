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
import { watch, type FSWatcher, promises as fs, existsSync } from "fs";
import { CreateApiClientAuth, hashFile } from "@checkpointvcs/common";
import { getWorkspaceState, type WorkspaceState } from "./util/index.js";

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
  }

  public async shutdown(): Promise<void> {
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

    // Get all files in workspace (excluding .checkpoint directory)
    const diskFiles = await fs.readdir(workspace.localPath, {
      recursive: true,
      withFileTypes: true,
    });

    // Get checkouts from API for checked-out file status
    const client = await CreateApiClientAuth(workspace.daemonId);
    const checkouts = await client.file.getCheckouts.query({
      workspaceId: workspace.id,
    });

    // Track which baseline files we've seen (to detect deletions)
    const seenBaselineFiles = new Set<string>();

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

      // Determine if file has changed
      let hasChanged = false;
      let needsHashCheck = false;

      if (!baselineFile) {
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

        const pendingFile: File = {
          path: relativePath,
          type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          status: !baselineFile
            ? FileStatus.Local // TODO: check if marked for add (and how marked for add is stored)
            : isCheckedOut
              ? FileStatus.ChangedCheckedOut
              : FileStatus.ChangedNotCheckedOut,
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
}
