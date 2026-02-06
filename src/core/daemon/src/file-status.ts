import ignore, { type Ignore } from "ignore";
import path from "path";
import { promises as fs, existsSync, constants } from "fs";
import { FileStatus } from "./types";
import type { WorkspaceState } from "@checkpointvcs/client";

const IGNORE_FILE = ".chkignore";
const HIDDEN_FILE = ".chkhidden";

interface IgnoreCache {
  ignore: Ignore;
  hidden: Ignore;
  lastUpdated: number;
}

/**
 * Cache of ignore/cloak patterns per workspace, keyed by workspace localPath
 */
const ignoreCaches = new Map<string, IgnoreCache>();

/**
 * Loads ignore patterns from a file, searching from the file's directory up to workspace root.
 * Patterns are accumulated from all ancestor directories.
 */
async function loadIgnorePatterns(
  workspacePath: string,
  fileName: string,
): Promise<string[]> {
  const patterns: string[] = [];

  // Always ignore .checkpoint directory
  if (fileName === IGNORE_FILE) {
    patterns.push(".checkpoint/");
    patterns.push(".checkpoint/**");
  }

  // Walk from workspace root to find all ignore files
  const dirsToCheck: string[] = [];

  // Collect all directories from root
  dirsToCheck.push(workspacePath);

  // Also check subdirectories by walking the workspace
  async function walkDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== ".checkpoint") {
          const subDir = path.join(dir, entry.name);
          dirsToCheck.push(subDir);
          await walkDir(subDir);
        }
      }
    } catch {
      // Directory may not be readable
    }
  }

  await walkDir(workspacePath);

  // Load patterns from each directory's ignore file
  for (const dir of dirsToCheck) {
    const ignoreFilePath = path.join(dir, fileName);
    try {
      if (existsSync(ignoreFilePath)) {
        const content = await fs.readFile(ignoreFilePath, "utf-8");
        const relativeDirFromWorkspace = path
          .relative(workspacePath, dir)
          .replace(/\\/g, "/");

        const lines = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));

        for (const line of lines) {
          // If the pattern is from a subdirectory, prefix it with the relative path
          if (relativeDirFromWorkspace) {
            patterns.push(`${relativeDirFromWorkspace}/${line}`);
          } else {
            patterns.push(line);
          }
        }
      }
    } catch {
      // File may not be readable
    }
  }

  return patterns;
}

/**
 * Gets or creates the ignore cache for a workspace.
 * Cache is refreshed if older than 5 seconds.
 */
async function getIgnoreCache(workspacePath: string): Promise<IgnoreCache> {
  const cached = ignoreCaches.get(workspacePath);
  const now = Date.now();

  // Use cached version if less than 5 seconds old
  if (cached && now - cached.lastUpdated < 5000) {
    return cached;
  }

  const [ignorePatterns, hiddenPatterns] = await Promise.all([
    loadIgnorePatterns(workspacePath, IGNORE_FILE),
    loadIgnorePatterns(workspacePath, HIDDEN_FILE),
  ]);

  const cache: IgnoreCache = {
    ignore: ignore().add(ignorePatterns),
    hidden: ignore().add(hiddenPatterns),
    lastUpdated: now,
  };

  ignoreCaches.set(workspacePath, cache);
  return cache;
}

/**
 * Clears the ignore cache for a workspace.
 * Call this when ignore/cloak files are modified.
 */
export function clearIgnoreCache(workspacePath: string): void {
  ignoreCaches.delete(workspacePath);
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

  // 2. Load ignore cache and check patterns
  const cache = await getIgnoreCache(workspacePath);

  // Check if ignored
  if (cache.ignore.ignores(relativePath)) {
    return { status: FileStatus.Ignored, fileId: null, changelist: null };
  }

  // 3. Check if hidden changes
  if (cache.hidden.ignores(relativePath)) {
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
 * Loads ignore cache once for all files.
 */
export async function getFileStatuses(
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
  const results = new Map<string, FileStatusResult>();

  // Pre-load ignore cache
  const cache = await getIgnoreCache(workspacePath);

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

    // Check if ignored
    if (cache.ignore.ignores(relativePath)) {
      results.set(relativePath, {
        status: FileStatus.Ignored,
        fileId: null,
        changelist: null,
      });
      continue;
    }

    // Check if hidden changes
    if (cache.hidden.ignores(relativePath)) {
      const stateFile = workspaceState?.files[relativePath];
      results.set(relativePath, {
        status: FileStatus.HiddenChanges,
        fileId: stateFile?.fileId ?? null,
        changelist: stateFile?.changelist ?? null,
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
