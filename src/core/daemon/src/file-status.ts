import ignore, { type Ignore } from "ignore";
import path from "path";
import { promises as fs, constants, type Dirent } from "fs";
import { FileStatus } from "./types/index.js";
import type { WorkspaceState } from "./util/index.js";

export const IGNORE_FILE = ".chkignore";
export const HIDDEN_FILE = ".chkhidden";
export const CHECKPOINT_DIR = ".checkpoint";

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

// ─── Separator Normalization ─────────────────────────────────────────

/**
 * Rewrites `\` as `/` and collapses repeated separators.
 *
 * Checkpoint runs on Windows, so both hand-written `.chkignore` lines and
 * paths handed to the daemon use backslashes, often mixed with forward
 * slashes in a single string (`path\to\some/folder/file.txt`). The `ignore`
 * package only understands `/`: it treats `\` as a literal character, so
 * `Saved\Config` silently matches nothing. Repeated separators matter too:
 * a doubled slash after a `**` segment stops the pattern matching anything.
 *
 * This deliberately diverges from gitignore, where `\` is an escape
 * character. Checkpoint has never supported those escapes (the parser strips
 * `#` comments without honouring `\#`), and treating `\` as a separator is
 * what a Windows user writing `.chkignore` actually means.
 */
export function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/**
 * Normalizes a workspace-relative path into the exact form the `ignore`
 * package accepts.
 *
 * On top of separator normalization this strips the leading `./` or `/` that
 * callers sometimes carry, and maps `.` to the empty string. Those forms are
 * not merely unmatched by `ignore`, they make it **throw**, so every path
 * entering a matcher goes through here.
 */
export function normalizeRelativePath(relativePath: string): string {
  const normalized = normalizeSeparators(relativePath)
    .replace(/^\.\//, "")
    .replace(/^\//, "");
  return normalized === "." ? "" : normalized;
}

// ─── Pattern Parsing Helpers ─────────────────────────────────────────

/**
 * Rewrites a single pattern line from a nested ignore/hidden file so it is
 * scoped to that file's directory, following gitignore semantics:
 *
 * - A leading `!` (negation) must stay at the front of the rewritten pattern.
 * - A pattern containing a `/` anywhere other than at the very end is anchored
 *   to the directory holding the ignore file (`build/out` → `sub/build/out`).
 * - A pattern with no `/` may match at any depth beneath that directory
 *   (`*.log` → `sub/**\/*.log`; `**` also matches zero directories, so this
 *   still matches `sub/a.log`).
 * - A trailing `/` (directory-only pattern) is preserved.
 *
 * Separators are normalized first, so `Saved\Config` anchors exactly like
 * `Saved/Config` and `Binaries\` is a directory-only rule.
 */
export function prefixIgnorePattern(relativeDir: string, line: string): string {
  const dir = normalizeRelativePath(relativeDir).replace(/\/+$/, "");
  const pattern = normalizeSeparators(line);

  if (!dir) return pattern;

  let body = pattern;
  let negation = "";
  if (body.startsWith("!")) {
    negation = "!";
    body = body.slice(1);
  }

  let dirOnly = "";
  if (body.endsWith("/")) {
    dirOnly = "/";
    body = body.slice(0, -1);
  }

  // A separator anywhere in the remaining body anchors the pattern to the
  // ignore file's own directory; otherwise it floats to any depth below it.
  const anchored = body.includes("/");
  const core = body.replace(/^\/+/, "");
  const scoped = anchored ? `${dir}/${core}` : `${dir}/**/${core}`;

  return `${negation}${scoped}${dirOnly}`;
}

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
      patterns.push(prefixIgnorePattern(relativeDirFromWorkspace, line));
    }
  } catch {
    // File may not be readable
  }
  return patterns;
}

// ─── Working-Tree Scanning ───────────────────────────────────────────

/**
 * Walks the **working tree** looking for `.chkignore` / `.chkhidden` files.
 *
 * Discovery is deliberately driven by what is on disk right now rather than by
 * the submitted baseline (state.json): a brand-new repo that has never
 * submitted anything still needs its `.chkignore` honoured, otherwise the first
 * `chk status` reports every build artifact in the tree.
 *
 * The walk is top-down and prunes subtrees that the already-discovered ignore
 * patterns exclude, which both matches git's behaviour (an ignored directory's
 * `.gitignore` has no effect) and keeps the scan cheap on Unreal-shaped trees
 * where `Saved/`, `Intermediate/` and `DerivedDataCache/` dominate the file
 * count. Entries are returned parent-first so deeper files can negate
 * shallower rules.
 */
export async function scanWorkspaceIgnoreFiles(
  workspacePath: string,
): Promise<WorkspaceIgnorePatterns> {
  const ignoreEntries: IgnoreFileEntry[] = [];
  const hiddenEntries: IgnoreFileEntry[] = [];

  // Ignore patterns discovered so far, used to prune the walk as we descend.
  const discovered: string[] = [`${CHECKPOINT_DIR}/`];
  let matcher: Ignore = ignore().add(discovered);

  const walk = async (relativeDir: string): Promise<void> => {
    const fullDir = relativeDir
      ? path.join(workspacePath, relativeDir)
      : workspacePath;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(fullDir, { withFileTypes: true });
    } catch {
      // Directory disappeared or is not readable
      return;
    }

    // Parse this directory's ignore/hidden files first so their patterns are
    // in effect before we decide which children to descend into.
    let addedPatterns = false;
    for (const fileName of [IGNORE_FILE, HIDDEN_FILE]) {
      if (!entries.some((e) => e.name === fileName && !e.isDirectory())) {
        continue;
      }

      const absolutePath = path.join(fullDir, fileName).replace(/\\/g, "/");
      const patterns = await parseIgnoreFile(workspacePath, absolutePath);
      const entry: IgnoreFileEntry = { absolutePath, relativeDir, patterns };

      if (fileName === IGNORE_FILE) {
        ignoreEntries.push(entry);
        if (patterns.length > 0) {
          discovered.push(...patterns);
          addedPatterns = true;
        }
      } else {
        // Hidden patterns never prune the walk: hidden files are still
        // tracked, their changes are just not surfaced by default.
        hiddenEntries.push(entry);
      }
    }

    if (addedPatterns) {
      matcher = ignore().add(discovered);
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!relativeDir && entry.name === CHECKPOINT_DIR) continue;

      const childRelative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (matchesPattern(matcher, childRelative, true)) continue;
      subdirs.push(childRelative);
    }

    // Sequential so entries come out in a stable parent-first, depth-first
    // order: negations in deeper files must be applied after their parents.
    for (const subdir of subdirs) {
      await walk(subdir);
    }
  };

  await walk("");

  return { ignore: ignoreEntries, hidden: hiddenEntries };
}

// ─── Cache Construction ──────────────────────────────────────────────

/**
 * Tests a workspace-relative path against a matcher.
 *
 * Every path reaching a matcher goes through here, so this is where separator
 * normalization is enforced: callers may hand over `Saved\Config` or a mixed
 * `path\to\some/folder/file.txt`, and `ignore` would either miss the match or
 * throw.
 *
 * The `ignore` package also matches purely on the string it is given, so a
 * directory-only pattern (`Saved/`) does not match the bare path `Saved`.
 * Callers that know they are testing a directory must therefore also probe the
 * trailing-slash form, otherwise directory-only rules silently do nothing.
 */
export function matchesPattern(
  matcher: Ignore,
  relativePath: string,
  isDirectory = false,
): boolean {
  const normalized = normalizeRelativePath(relativePath);
  // The workspace root itself is never ignorable, and `ignore` throws on "".
  if (!normalized) return false;

  if (matcher.ignores(normalized)) return true;
  if (!isDirectory || normalized.endsWith("/")) return false;
  return matcher.ignores(`${normalized}/`);
}

/**
 * Convenience wrapper: is this path excluded from pending changes entirely
 * (either ignored or hidden)?
 */
export function isIgnoredOrHidden(
  cache: IgnoreCache,
  relativePath: string,
  isDirectory = false,
): boolean {
  return (
    matchesPattern(cache.ignore, relativePath, isDirectory) ||
    matchesPattern(cache.hidden, relativePath, isDirectory)
  );
}

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
 * 1. If matches .chkignore patterns, return Ignored (files and directories)
 * 2. If a directory, return Unknown (directories aren't tracked individually)
 * 3. If matches .chkhidden patterns, return HiddenChanges
 * 4. If in pendingChanges, use that status
 * 5. If in state.json (controlled):
 *    - Check if file is writable -> WritableControlled or ReadOnlyControlled
 * 6. If not in state.json and not ignored -> Local
 * 7. Otherwise -> Unknown
 */
export async function getFileStatus(
  options: GetFileStatusOptions,
): Promise<FileStatusResult> {
  const {
    workspacePath,
    workspaceState,
    ignoreCache,
    pendingChanges,
    existsOnDisk,
    isDirectory,
  } = options;

  // Callers reach this from tRPC inputs and Windows path joins, so the key
  // used for every lookup below is normalized once here.
  const relativePath = normalizeRelativePath(options.relativePath);

  // Ignored paths are reported as such even when they're directories, so the
  // UI can grey out a whole excluded subtree instead of showing it as Unknown.
  if (matchesPattern(ignoreCache.ignore, relativePath, isDirectory)) {
    return { status: FileStatus.Ignored, fileId: null, changelist: null };
  }

  // Directories get Unknown status (they're not tracked individually)
  if (isDirectory) {
    return { status: FileStatus.Unknown, fileId: null, changelist: null };
  }

  // 3. Check if hidden changes
  if (matchesPattern(ignoreCache.hidden, relativePath)) {
    const stateFile = workspaceState?.files[relativePath];
    return {
      status: FileStatus.HiddenChanges,
      fileId: stateFile?.fileId ?? null,
      changelist: stateFile?.changelist ?? null,
    };
  }

  // 4. Check pending changes
  if (pendingChanges && pendingChanges[relativePath]) {
    const pending = pendingChanges[relativePath];
    return {
      status: pending.status,
      fileId: pending.id,
      changelist: pending.changelist,
    };
  }

  // 5. Check if file is in state.json (controlled)
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
    results.set(
      file.relativePath,
      await getFileStatus({
        workspacePath,
        relativePath: file.relativePath,
        workspaceState,
        ignoreCache,
        pendingChanges,
        existsOnDisk: file.existsOnDisk,
        isDirectory: file.isDirectory,
      }),
    );
  }

  return results;
}
