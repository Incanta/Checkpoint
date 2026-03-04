import ignore, { type Ignore } from "ignore";
import path from "path";
import { promises as fs, constants } from "fs";
import { FileStatus } from "./types/index.js";
import type { WorkspaceState } from "./util/index.js";

export const IGNORE_FILE = ".chkignore";
export const HIDDEN_FILE = ".chkhidden";

export interface IgnoreCache {
  ignore: Ignore;
  hidden: Ignore;
  lastUpdated: number;
}

/**
 * Represents a single ignore/hidden file discovered on disk, together with
 * the patterns it contributes (already prefixed with its relative directory).
 */
export interface IgnoreFileEntry {
  /** Absolute path to the ignore/hidden file on disk */
  absolutePath: string;
  /** Relative directory from workspace root (e.g. "" for root, "foo/bar") */
  relativeDir: string;
  /** Parsed pattern lines (already prefixed with relativeDir when non-root) */
  patterns: string[];
}

/**
 * Pre-loaded patterns for a workspace, keyed by file type.
 * Built once during workspace init and kept up-to-date by the watcher.
 */
export interface WorkspaceIgnorePatterns {
  ignore: IgnoreFileEntry[];
  hidden: IgnoreFileEntry[];
}

// ─── Pattern Parsing Helpers ─────────────────────────────────────────

/**
 * Reads a single ignore/hidden file and returns the parsed pattern lines,
 * already prefixed with the file's relative directory.
 */
export async function parseIgnoreFile(
  workspacePath: string,
  filePath: string,
): Promise<string[]> {
  const patterns: string[] = [];
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const relativeDirFromWorkspace = path
      .relative(workspacePath, path.dirname(filePath))
      .replace(/\\/g, "/");

    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    for (const line of lines) {
      if (relativeDirFromWorkspace) {
        patterns.push(`${relativeDirFromWorkspace}/${line}`);
      } else {
        patterns.push(line);
      }
    }
  } catch {
    // File may not be readable
  }
  return patterns;
}

// ─── Cache Construction ──────────────────────────────────────────────

/**
 * Flattens pre-loaded ignore file entries into a single pattern list for
 * building an {@link Ignore} instance.
 */
function flattenPatterns(
  entries: IgnoreFileEntry[],
  addCheckpointDir: boolean,
): string[] {
  const patterns: string[] = [];
  if (addCheckpointDir) {
    patterns.push(".checkpoint/");
    patterns.push(".checkpoint/**");
  }
  for (const entry of entries) {
    patterns.push(...entry.patterns);
  }
  return patterns;
}

/**
 * Builds an {@link IgnoreCache} directly from pre-loaded
 * {@link WorkspaceIgnorePatterns}. No filesystem access is needed.
 */
export function buildIgnoreCacheFromPatterns(
  preloaded: WorkspaceIgnorePatterns,
): IgnoreCache {
  return {
    ignore: ignore().add(flattenPatterns(preloaded.ignore, true)),
    hidden: ignore().add(flattenPatterns(preloaded.hidden, false)),
    lastUpdated: Date.now(),
  };
}

/**
 * Checks if a file is writable on the filesystem.
 */
async function isFileWritable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface FileStatusResult {
  status: FileStatus;
  fileId: string | null;
  changelist: number | null;
}

export interface GetFileStatusOptions {
  /** The workspace root path */
  workspacePath: string;
  /** The relative path from workspace root (normalized with forward slashes) */
  relativePath: string;
  /** The workspace state from state.json */
  workspaceState: WorkspaceState | null;
  /** Pre-built ignore cache (from DaemonManager) */
  ignoreCache: IgnoreCache;
  /** Pending changes for this workspace (if already computed) */
  pendingChanges?: Record<
    string,
    { status: FileStatus; id: string | null; changelist: number | null }
  >;
  /** Whether the file exists on disk */
  existsOnDisk: boolean;
  /** Whether this is a directory */
  isDirectory: boolean;
}

/**
 * Determines the FileStatus for a given file path.
 *
 * Resolution order:
 * 1. If in pendingChanges, use that status
 * 2. If matches .chkignore patterns, return Ignored
 * 3. If matches .chkhidden patterns, return HiddenChanges
 * 4. If in state.json (controlled):
 *    - Check if file is writable -> WritableControlled or ReadOnlyControlled
 * 5. If not in state.json and not ignored -> Local
 * 6. Otherwise -> Unknown
 */
export async function getFileStatus(
  options: GetFileStatusOptions,
): Promise<FileStatusResult> {
  const {
    workspacePath,
    relativePath,
    workspaceState,
    ignoreCache,
    pendingChanges,
    existsOnDisk,
    isDirectory,
  } = options;

  // Directories get Unknown status (they're not tracked individually)
  if (isDirectory) {
    return { status: FileStatus.Unknown, fileId: null, changelist: null };
  }

  // 1. Check pending changes first
  if (pendingChanges && pendingChanges[relativePath]) {
    const pending = pendingChanges[relativePath];
    return {
      status: pending.status,
      fileId: pending.id,
      changelist: pending.changelist,
    };
  }

  // 2. Check ignore patterns
  if (ignoreCache.ignore.ignores(relativePath)) {
    return { status: FileStatus.Ignored, fileId: null, changelist: null };
  }

  // 3. Check if hidden changes
  if (ignoreCache.hidden.ignores(relativePath)) {
    const stateFile = workspaceState?.files[relativePath];
    return {
      status: FileStatus.HiddenChanges,
      fileId: stateFile?.fileId ?? null,
      changelist: stateFile?.changelist ?? null,
    };
  }

  // 4. Check if file is in state.json (controlled)
  const stateFile = workspaceState?.files[relativePath];

  if (stateFile) {
    // File is controlled
    if (!existsOnDisk) {
      // Controlled but doesn't exist locally - this would be caught by pending changes
      // but if we got here, treat as Unknown
      return {
        status: FileStatus.Unknown,
        fileId: stateFile.fileId,
        changelist: stateFile.changelist,
      };
    }

    // Check if writable
    const fullPath = path.join(workspacePath, relativePath);
    const isWritable = await isFileWritable(fullPath);

    return {
      status: isWritable
        ? FileStatus.WritableControlled
        : FileStatus.ReadOnlyControlled,
      fileId: stateFile.fileId,
      changelist: stateFile.changelist,
    };
  }

  // 5. File is not in state.json and not ignored
  if (existsOnDisk) {
    // Local file (untracked)
    return { status: FileStatus.Local, fileId: null, changelist: null };
  }

  // 6. File doesn't exist and isn't tracked
  return { status: FileStatus.Unknown, fileId: null, changelist: null };
}

/**
 * Batch version of getFileStatus for efficiency when checking multiple files.
 */
export async function getFileStatuses(
  workspacePath: string,
  files: Array<{
    relativePath: string;
    existsOnDisk: boolean;
    isDirectory: boolean;
  }>,
  workspaceState: WorkspaceState | null,
  ignoreCache: IgnoreCache,
  pendingChanges?: Record<
    string,
    { status: FileStatus; id: string | null; changelist: number | null }
  >,
): Promise<Map<string, FileStatusResult>> {
  const results = new Map<string, FileStatusResult>();

  for (const file of files) {
    const { relativePath, existsOnDisk, isDirectory } = file;

    // Directories get Unknown status
    if (isDirectory) {
      results.set(relativePath, {
        status: FileStatus.Unknown,
        fileId: null,
        changelist: null,
      });
      continue;
    }

    // Check if ignored
    if (ignoreCache.ignore.ignores(relativePath)) {
      results.set(relativePath, {
        status: FileStatus.Ignored,
        fileId: null,
        changelist: null,
      });
      continue;
    }

    // Check if hidden changes
    if (ignoreCache.hidden.ignores(relativePath)) {
      const stateFile = workspaceState?.files[relativePath];
      results.set(relativePath, {
        status: FileStatus.HiddenChanges,
        fileId: stateFile?.fileId ?? null,
        changelist: stateFile?.changelist ?? null,
      });
      continue;
    }

    // Check pending changes first
    if (pendingChanges && pendingChanges[relativePath]) {
      const pending = pendingChanges[relativePath];
      results.set(relativePath, {
        status: pending.status,
        fileId: pending.id,
        changelist: pending.changelist,
      });
      continue;
    }

    // Check if controlled
    const stateFile = workspaceState?.files[relativePath];

    if (stateFile) {
      if (!existsOnDisk) {
        results.set(relativePath, {
          status: FileStatus.Unknown,
          fileId: stateFile.fileId,
          changelist: stateFile.changelist,
        });
        continue;
      }

      const fullPath = path.join(workspacePath, relativePath);
      const isWritable = await isFileWritable(fullPath);

      results.set(relativePath, {
        status: isWritable
          ? FileStatus.WritableControlled
          : FileStatus.ReadOnlyControlled,
        fileId: stateFile.fileId,
        changelist: stateFile.changelist,
      });
      continue;
    }

    // Local or Unknown
    if (existsOnDisk) {
      results.set(relativePath, {
        status: FileStatus.Local,
        fileId: null,
        changelist: null,
      });
    } else {
      results.set(relativePath, {
        status: FileStatus.Unknown,
        fileId: null,
        changelist: null,
      });
    }
  }

  return results;
}
