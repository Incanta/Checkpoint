import fs from "fs/promises";

/**
 * Symbolic links and Windows junctions in a workspace.
 *
 * Checkpoint does not store links yet: a link to a file is submitted with the
 * contents of the file it points to, and a link to a folder is never
 * submitted at all. Following one would pull whatever it points at into the
 * repo (a junction to an engine install is hundreds of thousands of files),
 * and a link inside that tree reaches the native submit as a "file" that is
 * really a folder. So folder links are left out of pending changes and never
 * walked; they are only listed, as links, when browsing the workspace.
 *
 * Node reports a junction as a symbolic link (lstat and Dirent alike), so the
 * same checks cover both.
 */
export interface LinkInfo {
  /** What the link points to, as stored in it. Empty when unreadable. */
  target: string;
  /** Whether it points to a folder. False when the target is missing. */
  directory: boolean;
}

/** Reads a link without following it further than its own target. */
export async function readLinkInfo(fullPath: string): Promise<LinkInfo> {
  const [target, stat] = await Promise.all([
    fs.readlink(fullPath).catch(() => ""),
    fs.stat(fullPath).catch(() => null),
  ]);
  return {
    // Windows hands some targets back in their verbatim form.
    target: target.replace(/^\\\\\?\\/, ""),
    directory: stat?.isDirectory() ?? false,
  };
}

/** Whether a path that lstat reports as a link points to a folder. */
export async function isDirectoryLink(fullPath: string): Promise<boolean> {
  return (await fs.stat(fullPath).catch(() => null))?.isDirectory() ?? false;
}
