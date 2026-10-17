import { promises as fs } from "fs";
import path from "path";

import type { PathKey } from "./volume.js";
import { resolveInWorkspace } from "./workspace-path.js";

// On a volume that takes two spellings for one name (volume.ts), a directory
// on disk keeps the spelling it was created with: writing "Docs/a.txt" into
// an existing "docs" leaves it "docs". When the tree renames a directory by
// case, the pull renames files in place, but their directory needs renaming
// too, or disk and state disagree about it. The scan takes such a difference
// for a rename the user made (daemon-manager.ts, dirRenamedOnDisk), so the
// pull lines the directories up with the tree, and records the ones it could
// not rename (a file inside open in another program) for the next pull.

/** Calls `fn` with each directory of `p`, and its key, shallowest first. */
function forEachDir(
  p: string,
  key: string,
  fn: (dir: string, dirKey: string) => void,
): void {
  const segs = p.split("/");
  const keySegs = key.split("/");
  // The keys fold each segment (or normalize the whole path, which leaves
  // "/" where it was), so the two split alike; anything else is skipped.
  if (segs.length !== keySegs.length) return;
  let dir = "";
  let dirKey = "";
  for (let i = 0; i < segs.length - 1; i++) {
    dir = i === 0 ? segs[0]! : `${dir}/${segs[i]}`;
    dirKey = i === 0 ? keySegs[0]! : `${dirKey}/${keySegs[i]}`;
    fn(dir, dirKey);
  }
}

export interface AlignDirectoriesInput {
  /** Tracked paths before the pull. */
  before: Iterable<string>;
  /** Tracked paths after it. */
  after: Iterable<string>;
  /** Paths the pull added. */
  added: Iterable<string>;
  /** Directories earlier pulls could not rename (pendingDirRenames). */
  retry: Iterable<string>;
}

export interface AlignDirectoriesResult {
  /** Directories renamed on disk, by their new spelling. */
  renamed: string[];
  /** Directories it could not rename, by their new spelling, with why. */
  failed: { path: string; error: string }[];
}

/**
 * Renames directories on disk to the tree's spelling where the tree now has
 * one spelling for them and disk has another. Only looks at directories the
 * pull added files to whose spelling changed, the topmost new directory of
 * each added path (one the user may have made by hand under another
 * spelling), and the retries, so an ordinary pull reads no directories.
 */
export async function alignDirectorySpellings(
  root: string,
  pathKey: PathKey,
  input: AlignDirectoriesInput,
): Promise<AlignDirectoriesResult> {
  const result: AlignDirectoriesResult = { renamed: [], failed: [] };

  // The spellings that might need putting on disk, by key.
  const wanted = new Map<string, string>();
  for (const p of input.added) {
    forEachDir(p, pathKey(p), (dir, dirKey) => {
      if (!wanted.has(dirKey)) wanted.set(dirKey, dir);
    });
  }
  const retry = new Set<string>();
  for (const dir of input.retry) {
    const dirKey = pathKey(dir);
    retry.add(dirKey);
    wanted.set(dirKey, dir);
  }
  if (wanted.size === 0) return result;

  const spellings = (paths: Iterable<string>) => {
    const out = new Map<string, Set<string>>();
    for (const p of paths) {
      forEachDir(p, pathKey(p), (dir, dirKey) => {
        if (!wanted.has(dirKey)) return;
        const set = out.get(dirKey);
        if (set) set.add(dir);
        else out.set(dirKey, new Set([dir]));
      });
    }
    return out;
  };
  const before = spellings(input.before);
  const after = spellings(input.after);

  const candidates: string[] = [];
  for (const [dirKey, dir] of wanted) {
    const now = after.get(dirKey);
    // Where the tree spells it two ways, disk can only match one of them.
    if (now?.size !== 1 || !now.has(dir)) continue;
    const was = before.get(dirKey);
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    const topmostNew =
      was === undefined && (parent === "" || before.has(pathKey(parent)));
    const respelled = was !== undefined && [...was].some((s) => s !== dir);
    if (retry.has(dirKey) || topmostNew || respelled) candidates.push(dir);
  }

  // Parents first, so a child is looked up under its parent's new name.
  candidates.sort((a, b) => a.split("/").length - b.split("/").length);
  for (const dir of candidates) {
    const slash = dir.lastIndexOf("/");
    const parentRel = slash >= 0 ? dir.slice(0, slash) : "";
    const name = dir.slice(slash + 1);
    try {
      const parentFull = parentRel
        ? resolveInWorkspace(root, parentRel)
        : path.resolve(root);
      const nameKey = pathKey(name);
      const onDisk = (await fs.readdir(parentFull)).find(
        (entry) => pathKey(entry) === nameKey,
      );
      if (onDisk === undefined || onDisk === name) continue;
      await fs.rename(
        path.join(parentFull, onDisk),
        path.join(parentFull, name),
      );
      result.renamed.push(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Gone (removed, or filtered out of this workspace): nothing to line up.
      if (code === "ENOENT") continue;
      result.failed.push({
        path: dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
