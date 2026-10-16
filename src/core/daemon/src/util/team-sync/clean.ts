import { promises as fs } from "fs";
import path from "path";
import {
  getWorkspaceState,
  type Workspace,
  type WorkspaceState,
} from "../util.js";
import { DaemonConfig } from "../../daemon-config.js";
import { Logger } from "../../logging.js";
import { workspacePathKey, type PathKey } from "../volume.js";

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
   * safe to remove; "untracked": any other unknown file (shown, but not
   * pre-selected by the UI).
   */
  category: "intermediate" | "untracked";
}

/** Directory names we never descend into while walking the workspace. */
const SKIP_DIRS = new Set([".checkpoint", ".git"]);

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

/**
 * True when a repo-relative path is accounted for by the workspace state
 * (synced source file, applied artifact, or marked-for-add) and therefore must
 * never be offered as a clean candidate or deleted.
 */
/**
 * Tracked paths by the key under which the workspace's volume takes two
 * spellings for one file (see volume.ts), or null where it tells them apart.
 */
type TrackedKeys = { key: PathKey; keys: Set<string> } | null;

async function trackedKeysFor(
  workspace: Workspace,
  state: WorkspaceState,
): Promise<TrackedKeys> {
  const key = await workspacePathKey(workspace.localPath);
  if (!key) return null;
  const keys = new Set<string>();
  for (const p of Object.keys(state.files)) keys.add(key(p));
  for (const p of Object.keys(state.artifactFiles ?? {})) keys.add(key(p));
  for (const p of state.markedForAdd ?? []) keys.add(key(p));
  return { key, keys };
}

function isTracked(
  relPath: string,
  state: WorkspaceState,
  folded: TrackedKeys = null,
): boolean {
  if (Object.prototype.hasOwnProperty.call(state.files, relPath)) {
    return true;
  }
  // The same file as a tracked path, spelled differently (the tree spells a
  // directory two ways, say): deleting it deletes the tracked file.
  if (folded && folded.keys.has(folded.key(relPath))) {
    return true;
  }
  if (
    state.artifactFiles &&
    Object.prototype.hasOwnProperty.call(state.artifactFiles, relPath)
  ) {
    return true;
  }
  if (state.markedForAdd && state.markedForAdd.includes(relPath)) {
    return true;
  }
  return false;
}

async function walk(
  absDir: string,
  relDir: string,
  state: WorkspaceState,
  out: CleanCandidate[],
  folded: TrackedKeys = null,
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
      if (relDir === "" && SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walk(absPath, relPath, state, out, folded);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isTracked(relPath, state, folded)) {
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
    state,
    out,
    await trackedKeysFor(workspace, state),
  );
  return out;
}

/**
 * Best-effort removal of directories left empty after deleting files, walking
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
    const absDir = path.join(workspace.localPath, relDir);
    try {
      const remaining = await fs.readdir(absDir);
      if (remaining.length > 0) {
        break;
      }
      await fs.rm(absDir, { recursive: false, force: true });
    } catch {
      break;
    }
    relDir = relDir.includes("/")
      ? relDir.slice(0, relDir.lastIndexOf("/"))
      : "";
  }
}

/**
 * Delete the given repo-relative paths from the workspace. Each path is
 * re-validated against a freshly loaded state before removal: it must resolve
 * strictly inside the workspace root, must not be a tracked/artifact file, and
 * must not live under ".checkpoint". Invalid paths are skipped (never thrown
 * for), so a partially valid batch still makes progress.
 *
 * @returns the number of files actually deleted.
 */
export async function executeClean(
  workspace: Workspace,
  relPaths: string[],
): Promise<{ deleted: number }> {
  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);
  const folded = await trackedKeysFor(workspace, state);

  const root = path.resolve(workspace.localPath);
  // Guard against sibling-directory prefix collisions ("root" vs "root-x").
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;

  let deleted = 0;

  for (const relPath of relPaths) {
    const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");

    if (
      !normalizedRel ||
      normalizedRel === ".checkpoint" ||
      normalizedRel.startsWith(".checkpoint/")
    ) {
      continue;
    }

    const absPath = path.resolve(root, normalizedRel);
    if (absPath !== root && !absPath.startsWith(rootPrefix)) {
      Logger.warn(`Skipping clean of path outside workspace: ${relPath}`);
      continue;
    }

    if (isTracked(normalizedRel, state, folded)) {
      // Still tracked in the current state; refuse to delete.
      continue;
    }

    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        continue;
      }
      await fs.rm(absPath, { force: true });
      deleted += 1;
      await pruneEmptyDirs(workspace, normalizedRel);
    } catch (e) {
      Logger.warn(`Failed to clean ${relPath}: ${String(e)}`);
      continue;
    }
  }

  return { deleted };
}
