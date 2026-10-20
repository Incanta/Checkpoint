import { constants as fsConstants, promises as fs } from "fs";
import path from "path";
import {
  getWorkspaceState,
  type Workspace,
  type WorkspaceState,
} from "../util.js";
import { DaemonConfig } from "../../daemon-config.js";
import { Logger } from "../../logging.js";
import { workspacePathKey, type PathKey } from "../volume.js";
import { foldName, namesCheckpointDir } from "../repo-path-rules.js";
import { resolveInWorkspace, UnsafePathError } from "../workspace-path.js";

// "Clean Workspace" (UnrealGameSync parity) removes files the workspace state
// does not account for. Two rules keep it from losing work:
//
//   - Anything the state still has a claim on is never touched: synced and
//     artifact files, files marked for add or staged (a staged new file is not
//     marked for add), pending modes, pull leftovers (pendingRemovals, which
//     may be a directory sitting where a tracked file was), directories a pull
//     could not rename, and anything under a .checkpoint directory. On a
//     volume that takes two spellings for one file, each is matched under
//     either spelling.
//   - Only regenerable build output ("intermediate") is deleted outright. Any
//     other file is moved into .checkpoint/clean-backups/<stamp>/, the way a
//     pull keeps local versions in .checkpoint/pull-backups/.

export const CLEAN_BACKUP_DIR = "clean-backups";

/**
 * A file on disk that is not part of the synced workspace state and is a
 * candidate for cleaning (UnrealGameSync "Clean Workspace" parity).
 */
export interface CleanCandidate {
  /** Repo-relative, forward-slash path. */
  path: string;
  size: number;
  /**
   * "intermediate": matches a well-known Unreal build/derived path and is
   * deleted outright when cleaned; "untracked": any other unknown file (shown,
   * but not pre-selected by the UI), moved to the clean backup folder when
   * cleaned rather than deleted.
   */
  category: "intermediate" | "untracked";
}

export interface CleanResult {
  /** Files deleted outright (intermediate build output only). */
  deleted: number;
  /** Untracked files moved into `backupRoot` instead of being deleted. */
  movedToBackup: number;
  /**
   * Absolute path of this run's backup folder, under
   * `.checkpoint/clean-backups/`, or null when nothing was moved there.
   */
  backupRoot: string | null;
  /** Paths that were left alone, and why. */
  skipped: { path: string; reason: string }[];
}

/** Directory names never descended into or cleaned, at any depth. */
function isSkippedDirName(name: string): boolean {
  return namesCheckpointDir(name) || name.toLowerCase() === ".git";
}

/**
 * Classify a repo-relative (forward-slash) path as an Unreal intermediate
 * artifact. The path is probed with a leading slash so segment patterns match
 * both at the workspace root and nested (e.g. both "Saved/x" and "Game/Saved/x").
 *
 * "Binaries" is treated as intermediate only for files that are NOT artifact
 * files; callers must have already excluded artifactFiles before calling this.
 */
function isIntermediatePath(relPath: string): boolean {
  const probe = `/${relPath.toLowerCase()}`;
  if (
    probe.includes("/intermediate/") ||
    probe.includes("/saved/") ||
    probe.includes("/deriveddatacache/") ||
    probe.includes("/.vs/") ||
    probe.includes("/binaries/")
  ) {
    return true;
  }

  const base = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".sln");
}

/** Every path from the first segment down to `relPath` itself. */
function selfAndAncestors(relPath: string): string[] {
  const out: string[] = [];
  for (let i = relPath.indexOf("/"); i >= 0; i = relPath.indexOf("/", i + 1)) {
    out.push(relPath.slice(0, i));
  }
  out.push(relPath);
  return out;
}

/** Folds each segment, whatever the volume does (for pendingDirRenames). */
const foldedPath: PathKey = (p) => p.split("/").map(foldName).join("/");

/**
 * What the workspace state still has a claim on. `files` are matched by
 * exact path; `trees` protect the path and everything under it, since a
 * staged or marked entry can be a new directory, and a pending removal can be
 * a directory standing where a tracked file was.
 */
interface Protection {
  files: Set<string>;
  trees: Set<string>;
  /** Directories a pull could not rename, by their folded spelling. */
  dirRenames: Set<string>;
  /** Keys of `files` and `trees` where the volume folds spellings, else null. */
  folded: { key: PathKey; files: Set<string>; trees: Set<string> } | null;
}

async function protectionFor(
  workspace: Workspace,
  state: WorkspaceState,
): Promise<Protection> {
  const files = new Set<string>([
    ...Object.keys(state.files),
    ...Object.keys(state.artifactFiles ?? {}),
  ]);
  const trees = new Set<string>([
    ...(state.markedForAdd ?? []),
    ...(state.staged ?? []),
    ...(state.pendingRemovals ?? []),
    ...Object.keys(state.pendingModes ?? {}),
  ]);
  const dirRenames = new Set((state.pendingDirRenames ?? []).map(foldedPath));

  const key = await workspacePathKey(workspace.localPath);
  const folded = key
    ? {
        key,
        files: new Set([...files].map(key)),
        trees: new Set([...trees].map(key)),
      }
    : null;
  return { files, trees, dirRenames, folded };
}

/**
 * Why the state forbids cleaning `relPath`, or null when it may be cleaned.
 */
function protectedReason(relPath: string, p: Protection): string | null {
  const chain = selfAndAncestors(relPath);
  for (const segmentPath of chain) {
    const name = segmentPath.slice(segmentPath.lastIndexOf("/") + 1);
    if (isSkippedDirName(name)) {
      return `it is inside a ${name} directory`;
    }
  }

  if (p.files.has(relPath)) return "it is tracked";
  for (const prefix of chain) {
    if (p.trees.has(prefix)) {
      return "it is staged, marked for add, or pending in the workspace state";
    }
  }
  if (p.folded) {
    // The same file as a protected path, spelled differently (the tree
    // spells a directory two ways, say): touching it touches that file.
    if (p.folded.files.has(p.folded.key(relPath))) {
      return "it is tracked under another spelling";
    }
    for (const prefix of chain) {
      if (p.folded.trees.has(p.folded.key(prefix))) {
        return "it is staged, marked for add, or pending under another spelling";
      }
    }
  }
  if (p.dirRenames.size > 0) {
    for (const prefix of chain.slice(0, -1)) {
      if (p.dirRenames.has(foldedPath(prefix))) {
        return "it is in a directory a pull has not finished renaming";
      }
    }
  }
  return null;
}

async function walk(
  absDir: string,
  relDir: string,
  protection: Protection,
  out: CleanCandidate[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    // Unreadable directory (permissions, race with another process): skip.
    return;
  }

  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    const absPath = path.join(absDir, entry.name);

    if (entry.isDirectory()) {
      if (isSkippedDirName(entry.name)) {
        continue;
      }
      await walk(absPath, relPath, protection, out);
      continue;
    }

    // Symlinks, junctions, devices: never offered.
    if (!entry.isFile()) {
      continue;
    }

    if (protectedReason(relPath, protection) !== null) {
      continue;
    }

    let size = 0;
    try {
      const stat = await fs.stat(absPath);
      size = stat.size;
    } catch {
      // File vanished between readdir and stat; skip it.
      continue;
    }

    out.push({
      path: relPath,
      size,
      category: isIntermediatePath(relPath) ? "intermediate" : "untracked",
    });
  }
}

/**
 * Enumerate files under the workspace that are not tracked by the workspace
 * state, classified as Unreal intermediates or generic untracked files.
 * Read-only: performs no deletions.
 */
export async function previewClean(
  workspace: Workspace,
): Promise<CleanCandidate[]> {
  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);

  const out: CleanCandidate[] = [];
  await walk(
    workspace.localPath,
    "",
    await protectionFor(workspace, state),
    out,
  );
  return out;
}

/**
 * Best-effort removal of directories left empty after cleaning files, walking
 * upward from `startRel` toward (but never including) the workspace root.
 */
async function pruneEmptyDirs(
  workspace: Workspace,
  startRel: string,
): Promise<void> {
  let relDir = startRel.includes("/")
    ? startRel.slice(0, startRel.lastIndexOf("/"))
    : "";

  while (relDir !== "") {
    try {
      const absDir = resolveInWorkspace(workspace.localPath, relDir);
      const remaining = await fs.readdir(absDir);
      if (remaining.length > 0) {
        break;
      }
      await fs.rmdir(absDir);
    } catch {
      break;
    }
    relDir = relDir.includes("/")
      ? relDir.slice(0, relDir.lastIndexOf("/"))
      : "";
  }
}

/** True when `child` is `parent` or inside it (both already resolved). */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/** Moves a file, copying then unlinking when it crosses devices. */
async function moveFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EXDEV") throw e;
    // COPYFILE_EXCL: never overwrite something already in the backup.
    await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    const stat = await fs.stat(from);
    await fs.utimes(to, stat.atime, stat.mtime).catch(() => undefined);
    await fs.unlink(from);
  }
}

/**
 * Cleans the given repo-relative paths from the workspace. Each one is
 * re-validated before it is touched: it must pass resolveInWorkspace, must
 * not be claimed by a freshly loaded state (see protectedReason), must be a
 * regular file, and must not be reached through a link out of the workspace.
 * Intermediate build output is deleted; any other file is moved into
 * `.checkpoint/clean-backups/<stamp>/<path>`. Invalid paths are skipped and
 * reported (never thrown for), so a partially valid batch still makes
 * progress.
 */
export async function executeClean(
  workspace: Workspace,
  relPaths: string[],
): Promise<CleanResult> {
  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);

  if (state.interruptedPull && !state.interruptedPull.restoredAt) {
    // Recovery has not yet put the dead pull's backed-up local edits back,
    // and the files it wrote are not in the state: the scan cannot tell
    // what is whose until the next pull completes.
    throw new Error(
      "A pull was interrupted in this workspace and has not been recovered. Pull again before cleaning.",
    );
  }

  const protection = await protectionFor(workspace, state);
  const root = path.resolve(workspace.localPath);
  const realRoot = await fs.realpath(root).catch(() => root);

  const result: CleanResult = {
    deleted: 0,
    movedToBackup: 0,
    backupRoot: null,
    skipped: [],
  };
  // Short, as the pull's: every backup path is the file's own path under this
  // folder, and many Windows tools stop at 260 characters.
  const backupRoot = path.join(
    root,
    ".checkpoint",
    CLEAN_BACKUP_DIR,
    Date.now().toString(36),
  );
  const skip = (p: string, reason: string) => {
    result.skipped.push({ path: p, reason });
  };
  const seen = new Set<string>();

  for (const relPath of relPaths) {
    const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (seen.has(normalizedRel)) continue;
    seen.add(normalizedRel);

    let absPath: string;
    try {
      absPath = resolveInWorkspace(root, normalizedRel);
    } catch (e) {
      const reason = e instanceof UnsafePathError ? e.reason : String(e);
      Logger.warn(`Skipping clean of unsafe path ${relPath}: ${reason}`);
      skip(relPath, reason);
      continue;
    }

    const refusal = protectedReason(normalizedRel, protection);
    if (refusal) {
      skip(relPath, refusal);
      continue;
    }

    try {
      const stat = await fs.lstat(absPath);
      if (stat.isDirectory()) {
        skip(relPath, "it is a directory");
        continue;
      }
      if (!stat.isFile()) {
        skip(relPath, "it is not a regular file");
        continue;
      }
      // resolveInWorkspace is lexical: a linked or junctioned directory on
      // the way could still lead out of the workspace.
      const realParent = await fs.realpath(path.dirname(absPath));
      if (!isWithin(realRoot, realParent)) {
        skip(relPath, "it is reached through a link out of the workspace");
        continue;
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      skip(relPath, code === "ENOENT" ? "it does not exist" : String(e));
      continue;
    }

    try {
      if (isIntermediatePath(normalizedRel)) {
        await fs.rm(absPath, { force: true });
        result.deleted += 1;
      } else {
        await moveFile(absPath, path.join(backupRoot, normalizedRel));
        result.movedToBackup += 1;
        result.backupRoot = backupRoot;
      }
      await pruneEmptyDirs(workspace, normalizedRel);
    } catch (e) {
      Logger.warn(`Failed to clean ${relPath}: ${String(e)}`);
      skip(relPath, `it could not be cleaned: ${String(e)}`);
    }
  }

  if (result.movedToBackup > 0) {
    Logger.info(
      `Clean Workspace kept ${result.movedToBackup} untracked file(s) in ${backupRoot}`,
    );
  }
  return result;
}
