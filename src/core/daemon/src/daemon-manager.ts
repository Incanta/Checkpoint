import path from "path";
import { DaemonConfig, DaemonConfigType } from "./daemon-config.js";
import { InitLogger, Logger } from "./logging.js";
import {
  FileStatus,
  FileType,
  type File,
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
  saveWorkspaceState,
  getWorkspaceConfig,
  saveWorkspaceConfig,
  closeAllStateStores,
  type WorkspaceState,
} from "./util/index.js";
import {
  parseIgnoreFile,
  buildIgnoreCacheFromPatterns,
  getFileStatuses as computeFileStatuses,
  IGNORE_FILE,
  HIDDEN_FILE,
  type WorkspaceIgnorePatterns,
  type IgnoreFileEntry,
  type IgnoreCache,
  type FileStatusResult,
} from "./file-status.js";
import { checkSyncStatus, type SyncStatus } from "./util/sync-status.js";
import { hasConflictMarkers } from "./util/auto-merge.js";
import { getBinaryExtensions, isBinaryFile } from "./util/binary-extensions.js";

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

  private watchers: Map<string, FSWatcher> = new Map();

  /** Cached sync status per workspace, keyed by workspace.id */
  private syncStatuses: Map<string, SyncStatus> = new Map();

  /** Cached set of directories containing tracked files, keyed by workspace.id */
  private trackedDirSets: Map<string, Set<string>> = new Map();

  /** Pre-loaded ignore/hidden patterns per workspace, keyed by workspace.id */
  private ignorePatterns: Map<string, WorkspaceIgnorePatterns> = new Map();

  /** Pre-built IgnoreCache per workspace, keyed by workspace.id */
  private ignoreCaches: Map<string, IgnoreCache> = new Map();

  /** Interval handle for sync polling */
  private syncPollInterval: ReturnType<typeof setInterval> | null = null;

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
      const existing = this.workspaces.get(workspace.daemonId) || [];
      existing.push(workspace);
      this.workspaces.set(workspace.daemonId, existing);

      // Load state.json baseline for each workspace
      await this.loadWorkspaceState(workspace);

      // One-time scan for ignore/hidden files
      await this.scanIgnoreFiles(workspace);

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
    closeAllStateStores();
  }

  /**
   * Unlinks a workspace: stops watching, clears all cached state.
   * Does NOT delete the .checkpoint directory on disk.
   */
  public unlinkWorkspace(workspaceId: string, daemonId: string): void {
    // Close file watcher
    const watcher = this.watchers.get(workspaceId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(workspaceId);
    }

    // Clear all cached state
    this.workspaceStates.delete(workspaceId);
    this.dirtyFiles.delete(workspaceId);
    this.workspacePendingChanges.delete(workspaceId);
    this.syncStatuses.delete(workspaceId);
    this.trackedDirSets.delete(workspaceId);
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
    this.trackedDirSets.delete(workspace.id);
  }

  // ─── Ignore / Hidden File Management ────────────────────────────────

  /**
   * Performs a one-time scan for all `.chkignore` and `.chkhidden` files in
   * the workspace and caches the results. Only walks directories in the
   * tracked-directory set. Subsequent updates are handled incrementally by
   * {@link watchWorkspace}.
   */
  public async scanIgnoreFiles(workspace: Workspace): Promise<void> {
    if (!existsSync(workspace.localPath)) return;

    const trackedDirs = this.getTrackedDirSet(workspace.id);

    const scanForFile = async (
      fileName: string,
    ): Promise<IgnoreFileEntry[]> => {
      const entries: IgnoreFileEntry[] = [];

      for (const dir of trackedDirs) {
        const fullDir = dir
          ? path.join(workspace.localPath, dir)
          : workspace.localPath;
        const ignoreFilePath = path.join(fullDir, fileName);
        try {
          if (existsSync(ignoreFilePath)) {
            const relativeDir = dir;
            const patterns = await parseIgnoreFile(
              workspace.localPath,
              ignoreFilePath,
            );
            entries.push({
              absolutePath: ignoreFilePath.replace(/\\/g, "/"),
              relativeDir,
              patterns,
            });
          }
        } catch {
          // File may not be readable
        }
      }

      return entries;
    };

    const [ignoreEntries, hiddenEntries] = await Promise.all([
      scanForFile(IGNORE_FILE),
      scanForFile(HIDDEN_FILE),
    ]);

    const patterns: WorkspaceIgnorePatterns = {
      ignore: ignoreEntries,
      hidden: hiddenEntries,
    };

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
   * Re-parses only the affected file and rebuilds the IgnoreCache.
   */
  private async handleIgnoreFileChange(
    workspace: Workspace,
    relativePath: string,
  ): Promise<void> {
    const fileName = path.basename(relativePath);
    const isIgnore = fileName === IGNORE_FILE;
    const isHidden = fileName === HIDDEN_FILE;
    if (!isIgnore && !isHidden) return;

    const patterns = this.ignorePatterns.get(workspace.id);
    if (!patterns) return;

    const list = isIgnore ? patterns.ignore : patterns.hidden;
    const absolutePath = path
      .join(workspace.localPath, relativePath)
      .replace(/\\/g, "/");
    const relativeDir = relativePath.includes("/")
      ? relativePath.substring(0, relativePath.lastIndexOf("/"))
      : "";

    // Remove old entry for this file (if any)
    const idx = list.findIndex((e) => e.absolutePath === absolutePath);
    if (idx !== -1) {
      list.splice(idx, 1);
    }

    // Re-parse if the file still exists
    if (existsSync(path.join(workspace.localPath, relativePath))) {
      const newPatterns = await parseIgnoreFile(
        workspace.localPath,
        path.join(workspace.localPath, relativePath),
      );
      list.push({
        absolutePath,
        relativeDir,
        patterns: newPatterns,
      });
    }

    // Rebuild the IgnoreCache from updated patterns
    this.ignoreCaches.set(workspace.id, buildIgnoreCacheFromPatterns(patterns));

    Logger.debug(
      `[DaemonManager] Rebuilt ignore cache for workspace ${workspace.name} (${fileName} changed at ${relativeDir || "root"})`,
    );
  }

  /**
   * Returns the cached {@link IgnoreCache} for a workspace. Always available
   * after {@link init} has run.
   */
  public getIgnoreCache(workspaceId: string): IgnoreCache {
    const cached = this.ignoreCaches.get(workspaceId);
    if (cached) return cached;

    // Fallback: build an empty cache (shouldn't normally happen)
    const empty: WorkspaceIgnorePatterns = { ignore: [], hidden: [] };
    const cache = buildIgnoreCacheFromPatterns(empty);
    this.ignoreCaches.set(workspaceId, cache);
    return cache;
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
          ignoreCache.ignore.ignores(childRelative) ||
          ignoreCache.hidden.ignores(childRelative)
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
    trackedDirs: Set<string>,
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
    directoryPath: string,
  ): Promise<{ children: File[]; containsChanges: boolean }> {
    const ignoreCache = this.getIgnoreCache(workspaceId);
    const workspaceState = this.getWorkspaceState(workspaceId);
    const trackedDirs = this.getTrackedDirSet(workspaceId);
    const pendingChanges = this.workspacePendingChanges.get(workspaceId);

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
      if (
        ignoreCache.ignore.ignores(relativePath) ||
        ignoreCache.hidden.ignores(relativePath)
      ) {
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
              checkouts: [],
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
              checkouts: [],
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
              checkouts: [],
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
          // Direct child — add if not already present
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
            checkouts: [],
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

    // Classify modifications into files vs directories in parallel batches
    const CONCURRENCY = 256;
    type ClassifiedMod = {
      mod: { delete: boolean; path: string; oldPath?: string };
      normalizedPath: string;
      isDir: boolean;
      exists: boolean;
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
            return {
              mod,
              normalizedPath,
              isDir: stat.isDirectory(),
              exists: true,
            };
          } catch {
            return { mod, normalizedPath, isDir: false, exists: false };
          }
        }),
      );
      for (const r of results) classified.push(r);
    }

    // Process non-directory modifications (the vast majority)
    for (const { mod, isDir, exists } of classified) {
      if (!isDir) {
        if (!exists) {
          // Path doesn't exist on disk — could be a deleted file, pass through
          result.push(mod);
        } else {
          result.push(mod);
        }
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
        if (ignoreCache.ignore.ignores(childRelative)) continue;
        if (ignoreCache.hidden.ignores(childRelative)) continue;

        if (entry.isDirectory()) {
          subdirs.push(childRelative);
        } else {
          result.push({ delete: false, path: childRelative });
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
        const statePrefix = normalizedPath + "/";
        const deletedChecks: Array<{ normalized: string; fileFull: string }> =
          [];
        for (const filePath of Object.keys(workspaceState.files)) {
          const normalized = filePath.replace(/^\//, "");
          if (normalized.startsWith(statePrefix)) {
            deletedChecks.push({
              normalized,
              fileFull: path.join(workspace.localPath, normalized),
            });
          }
        }
        // Check existence in parallel batches
        for (let i = 0; i < deletedChecks.length; i += CONCURRENCY) {
          const batch = deletedChecks.slice(i, i + CONCURRENCY);
          const exists = await Promise.all(
            batch.map(async ({ fileFull }) => existsSync(fileFull)),
          );
          for (let j = 0; j < batch.length; j++) {
            if (!exists[j]) {
              result.push({ delete: true, path: batch[j].normalized });
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

  // ─── Tracked Directory Helpers ──────────────────────────────────────

  /**
   * Builds a set of directory paths (relative, forward-slash) that contain
   * tracked files or their ancestors. The workspace root ("") is always
   * included. Useful for pruning untracked subtrees during a full walk.
   */
  private buildTrackedDirSet(
    state: WorkspaceState,
    markedForAdd?: string[],
  ): Set<string> {
    const dirs = new Set<string>();
    dirs.add("");

    const addAncestorDirs = (filePath: string) => {
      const parts = filePath.replace(/^\//, "").split("/");
      parts.pop(); // remove filename
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        dirs.add(current);
      }
    };

    for (const filePath of Object.keys(state.files)) {
      addAncestorDirs(filePath);
    }

    if (markedForAdd) {
      for (const filePath of markedForAdd) {
        addAncestorDirs(filePath);
      }
    }

    return dirs;
  }

  /**
   * Returns the cached tracked-directory set for a workspace, building it
   * lazily on first access (invalidated when baseline state changes).
   */
  private getTrackedDirSet(workspaceId: string): Set<string> {
    let cached = this.trackedDirSets.get(workspaceId);
    if (!cached) {
      const state = this.workspaceStates.get(workspaceId);
      if (state) {
        cached = this.buildTrackedDirSet(state, state.markedForAdd);
        this.trackedDirSets.set(workspaceId, cached);
      } else {
        cached = new Set([""]);
      }
    }
    return cached;
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
    checkouts: Array<{ fileId: string }>,
    markedForAdd: Set<string>,
  ): Promise<File | null> {
    let hasChanged = false;
    let needsHashCheck = false;

    if (!baselineFile) {
      // File doesn't exist in baseline – it's new / added
      hasChanged = true;
    } else if (stat.size !== baselineFile.size) {
      // Size changed – definitely modified
      hasChanged = true;
    } else if (baselineFile.mtime && stat.mtimeMs !== baselineFile.mtime) {
      // Mtime changed but size identical – verify with hash
      needsHashCheck = true;
    }

    if (needsHashCheck && baselineFile) {
      const fullPath = path
        .join(workspace.localPath, relativePath)
        .replace(/\\/g, "/");
      if (baselineFile.md5 === "") {
        // Hash was deferred after pull. Compute and cache it as the baseline
        // so subsequent checks have a real hash to compare against.
        baselineFile.md5 = await hashFileMD5(fullPath);
        baselineFile.mtime = stat.mtimeMs;
      } else {
        const currentHash = await hashFileMD5(fullPath);
        hasChanged = currentHash !== baselineFile.md5;
      }
    }

    if (!hasChanged) return null;

    const isCheckedOut = baselineFile
      ? checkouts.some((c) => c.fileId === baselineFile.fileId)
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
      checkouts: [],
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
    checkouts: Array<{ fileId: string }>,
  ): Promise<void> {
    const changedFileIds = new Set(
      Object.values(result.files)
        .map((f) => f.id)
        .filter(Boolean),
    );

    for (const checkout of checkouts) {
      if (!changedFileIds.has(checkout.fileId)) {
        const baselineEntry = Object.entries(baselineState.files).find(
          ([, file]) => file.fileId === checkout.fileId,
        );

        if (baselineEntry) {
          const [relativePath, baselineFile] = baselineEntry;
          const fullPath = path.join(workspace.localPath, relativePath);

          if (existsSync(fullPath)) {
            const stat = await fs.lstat(fullPath);
            result.files[relativePath] = {
              path: relativePath,
              type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
              status: FileStatus.NotChangedCheckedOut,
              id: checkout.fileId,
              changelist: baselineFile.changelist,
              checkouts: [],
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
      let ignoreChanged = false;
      for (const dirtyPath of dirty) {
        const baseName = path.basename(dirtyPath);
        if (baseName === IGNORE_FILE || baseName === HIDDEN_FILE) {
          await this.handleIgnoreFileChange(workspace, dirtyPath);
          ignoreChanged = true;
        }
      }
      if (ignoreChanged) {
        this.workspacePendingChanges.delete(workspace.id);
      }
    }

    const cached = this.workspacePendingChanges.get(workspace.id);

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
      return this.incrementalRefresh(workspace, baselineState, cached, dirty);
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

    // Walk recursively, skipping ignored/hidden paths.
    // Untracked directories get a single directory entry instead of recursion.
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
          if (!trackedDirs.has(relativePath)) {
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
                checkouts: [],
              };
              result.numChanges++;
            }
            return;
          }
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

    // Process all files found on disk
    const promises = diskFiles.map(async (f) => {
      if (f.isDirectory()) return;

      const fullPath = path.join(f.parentPath, f.name).replace(/\\/g, "/");
      const relativePath = this.getRelativePath(workspace, fullPath);

      // Skip .checkpoint directory
      if (relativePath.startsWith(".checkpoint")) {
        return;
      }

      const stat = await fs.lstat(fullPath);
      const baselineFile = baselineState.files[relativePath];

      if (baselineFile) {
        seenBaselineFiles.add(relativePath);
      }

      const pendingFile = await this.detectFileChange(
        workspace,
        relativePath,
        stat,
        baselineFile,
        checkouts,
        markedForAdd,
      );

      if (pendingFile) {
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
        result.files[relativePath] = {
          path: relativePath,
          type: FileType.Unknown,
          size: 0,
          modifiedAt: 0,
          status: FileStatus.Deleted,
          id: baselineFile.fileId,
          changelist: baselineFile.changelist,
          checkouts: [],
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
    const checkouts = await client.file.getCheckouts.query({
      workspaceId: workspace.id,
      repoId: workspace.repoId,
    });

    // Expand directory-level dirty paths: when a whole directory is
    // reported as changed, include every baseline / cached file beneath it.
    const expandedDirty = new Set(dirtyPaths);
    for (const dirtyPath of dirtyPaths) {
      const prefix = dirtyPath.endsWith("/") ? dirtyPath : dirtyPath + "/";
      for (const filePath of Object.keys(baselineState.files)) {
        const normalized = filePath.replace(/^\//, "");
        if (normalized.startsWith(prefix)) {
          expandedDirty.add(normalized);
        }
      }
      for (const filePath of Object.keys(cached.files)) {
        if (filePath.startsWith(prefix)) {
          expandedDirty.add(filePath);
        }
      }
    }

    for (const relativePath of expandedDirty) {
      if (relativePath.startsWith(".checkpoint")) continue;

      // Skip ignored / hidden files
      if (
        ignoreCache.ignore.ignores(relativePath) ||
        ignoreCache.hidden.ignores(relativePath)
      ) {
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
          // ensure it appears as a Local directory entry.
          if (!trackedDirs.has(relativePath)) {
            if (!result.files[relativePath]) {
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
                  checkouts: [],
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
        // File deleted (or is a directory)
        if (baselineFile) {
          result.files[relativePath] = {
            path: relativePath,
            type: FileType.Unknown,
            size: 0,
            modifiedAt: 0,
            status: FileStatus.Deleted,
            id: baselineFile.fileId,
            changelist: baselineFile.changelist,
            checkouts: [],
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
                checkouts: [],
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
        checkouts,
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
        if (!checkouts.some((c) => c.fileId === file.id)) {
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

    this.workspacePendingChanges.set(workspace.id, result);
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
          }
          return;
        }

        Logger.debug(
          `[DaemonManager] Detected change in workspace ${workspace.name} (${eventType} on ${relativePath})`,
        );

        // If an ignore/hidden file changed, rebuild the cached patterns
        // and force a full refresh so new ignore rules take effect.
        const baseName = path.basename(relativePath);
        if (baseName === IGNORE_FILE || baseName === HIDDEN_FILE) {
          await this.handleIgnoreFileChange(workspace, relativePath);
          this.workspacePendingChanges.delete(workspace.id);
        }

        // Mark file as dirty for incremental refresh
        const dirty = this.dirtyFiles.get(workspace.id);
        if (dirty) {
          dirty.add(relativePath);
        }
      },
    );

    watcher.on("error", (err) => {
      Logger.warn(
        `[DaemonManager] Watcher error for workspace ${workspace.name}: ${err.message}`,
      );
      // Remove the broken watcher and try to re-establish after a short delay.
      // The directory may have been temporarily removed (e.g. test cleanup).
      this.watchers.delete(workspace.id);
      setTimeout(() => {
        if (!this.watchers.has(workspace.id)) {
          this.watchWorkspace(workspace);
        }
      }, 5000);
    });

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

    // Invalidate caches so next refresh picks up the new status
    this.workspacePendingChanges.delete(workspace.id);
    this.trackedDirSets.delete(workspace.id);
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

    // Invalidate caches so next refresh picks up the new status
    this.workspacePendingChanges.delete(workspace.id);
    this.trackedDirSets.delete(workspace.id);
  }

  /**
   * Persist the in-memory workspace state back to state.json (and workspace.json).
   */
  private async persistState(
    workspace: Workspace,
    state: WorkspaceState,
  ): Promise<void> {
    await saveWorkspaceState(workspace as any, state, this.stateBackend);
  }

  // ─── VCS Operation Guard ─────────────────────────────────────────

  /**
   * Begins buffering file-watcher events for a workspace while a VCS
   * operation (pull, submit, merge) runs. Call this before the operation
   * starts and pair it with {@link endVcsOperation} in a `finally` block.
   */
  public beginVcsOperation(workspaceId: string): void {
    this.vcsOperationActive.set(workspaceId, true);
    this.vcsBufferedEvents.set(workspaceId, new Set());
    Logger.debug(
      `[DaemonManager] VCS operation started for workspace ${workspaceId} — watcher events buffered`,
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

      // Handle any ignore/hidden file changes that arrived during the
      // VCS operation so the ignore cache stays current.
      for (const relativePath of buffered) {
        const baseName = path.basename(relativePath);
        if (baseName === IGNORE_FILE || baseName === HIDDEN_FILE) {
          const workspace = this.findWorkspaceById(workspaceId);
          if (workspace) {
            await this.handleIgnoreFileChange(workspace, relativePath);
          }
        }
      }

      Logger.debug(
        `[DaemonManager] VCS operation ended for workspace ${workspaceId} — replayed ${buffered.size} buffered event(s)`,
      );
    } else {
      Logger.debug(
        `[DaemonManager] VCS operation ended for workspace ${workspaceId} — no buffered events`,
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
