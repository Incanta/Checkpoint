import path from "path";
import { promises as fs, existsSync } from "fs";
import { createHash } from "crypto";

/**
 * Content store for partially-staged files: Checkpoint's index.
 *
 * A fully-staged file needs nothing here, because its staged content IS the
 * worktree content and submit reads that off disk. Only a file where some
 * hunks are staged and others are not has a third state to keep, and that is
 * what lives here.
 *
 * Stored under `.checkpoint/staged-blobs/`, keyed by a hash of the repo path
 * so nested directories never need creating and no path-length limit is hit
 * on a deep game tree.
 */

function blobDir(workspaceLocalPath: string): string {
  return path.join(workspaceLocalPath, ".checkpoint", "staged-blobs");
}

function blobPath(workspaceLocalPath: string, relPath: string): string {
  const key = createHash("sha256").update(relPath).digest("hex");
  return path.join(blobDir(workspaceLocalPath), key);
}

/** Records the partially-staged content for a path. */
export async function writeStagedBlob(
  workspaceLocalPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  const dir = blobDir(workspaceLocalPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(blobPath(workspaceLocalPath, relPath), content, "utf-8");
}

/** Returns the partially-staged content, or null if the file is not partial. */
export async function readStagedBlob(
  workspaceLocalPath: string,
  relPath: string,
): Promise<string | null> {
  const p = blobPath(workspaceLocalPath, relPath);
  if (!existsSync(p)) {
    return null;
  }
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Drops a path's blob.
 *
 * Called when a file becomes fully staged, fully unstaged, or is submitted:
 * in all three cases the third state has stopped existing.
 */
export async function clearStagedBlob(
  workspaceLocalPath: string,
  relPath: string,
): Promise<void> {
  try {
    await fs.rm(blobPath(workspaceLocalPath, relPath), { force: true });
  } catch {
    // A missing blob is the normal case; nothing to report.
  }
}

/** True when this path has partially-staged content distinct from the worktree. */
export function hasStagedBlob(
  workspaceLocalPath: string,
  relPath: string,
): boolean {
  return existsSync(blobPath(workspaceLocalPath, relPath));
}
