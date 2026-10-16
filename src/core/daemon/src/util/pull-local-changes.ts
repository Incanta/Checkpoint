import { createHash } from "crypto";
import { existsSync, promises as fs } from "fs";
import path from "path";
import type { WorkspaceStateFile } from "@checkpointvcs/common";
import { autoMergeText } from "./auto-merge.js";
import { compareWithBaseline } from "./baseline.js";
import { resolveInWorkspace } from "./workspace-path.js";

// Keeping local work safe across a pull.
//
// A pull writes the server's versions of changed files straight into the
// workspace, and deletes the ones the server deleted. Any of those files may
// have local changes: an edit that was never submitted, or a file that was
// never added. The pull used to handle exactly one case, a text file changed
// on both sides, by holding the local text in memory and merging afterwards.
// Everything else was simply overwritten or deleted: a locally edited binary,
// a local edit to a file deleted upstream, an untracked file with the same
// name as a newly added one. And the one handled case lost the edit too if the
// merge threw or the pull failed partway, because the only copy was in memory.
//
// The rule now: before the pull changes anything, every file it is about to
// overwrite or delete that has local changes is copied into a backup folder
// inside the workspace's .checkpoint directory. After the pull:
//
//   - text changed on both sides is merged three ways, as before;
//   - anything that cannot be merged (binary, not valid text, no common base,
//     or the merge itself failed) keeps the server's version in the workspace,
//     and the local version stays in the backup folder and is reported;
//   - if the pull fails, every backed-up file is put back.
//
// A backup is deleted only when it turned out to be identical to what the
// pull wrote, or when a merge kept everything it contained.

export const BACKUP_DIR = "pull-backups";

/** How a file with local changes was affected by the pull. */
export type IncomingKind =
  /** The server has a newer version of a file the workspace tracks. */
  | "modified"
  /** The server added a path that already exists locally, untracked. */
  | "added"
  /** The server deleted the file. */
  | "removed";

export interface ProtectedFile {
  relativePath: string;
  kind: IncomingKind;
  /** The changelist the local copy was based on; null if it was untracked. */
  baseCl: number | null;
  /** Absolute path of the copy of the local version. */
  backupPath: string;
}

export type SetAsideReason =
  | "binary"
  | "not-text"
  | "no-common-base"
  | "merge-failed"
  | "deleted-on-server";

export interface SetAsideFile {
  relativePath: string;
  /** Where the local version was kept. */
  backupPath: string;
  reason: SetAsideReason;
}

export interface MergedFile {
  relativePath: string;
  clean: boolean;
  /**
   * What the server's version looked like on disk before the merge was written
   * over it. This, not the merged file, is the baseline for change detection:
   * recording the merged file as the baseline would make the local edits it
   * contains look like nothing had changed.
   */
  incoming: { size: number; mtime: number; md5: string };
}

export interface ResolveResult {
  merged: MergedFile[];
  setAside: SetAsideFile[];
}

/** True when the bytes are valid UTF-8 text that survives a round trip. */
export function isMergeableText(bytes: Buffer): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

function md5(bytes: Buffer): string {
  return createHash("md5").update(bytes).digest("hex");
}

/**
 * Whether a file on disk differs from what the workspace state recorded for
 * it. Errs toward "yes": a false yes costs one file copy, a false no costs the
 * user's work.
 */
export async function hasLocalChanges(
  fullPath: string,
  entry: WorkspaceStateFile | undefined,
): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return false; // Nothing on disk, so nothing to lose.
  }
  if (!stat.isFile()) {
    return false;
  }
  const verdict = compareWithBaseline(stat, entry, {
    whenUnknowable: "changed",
  });
  if (verdict !== "compare-hash") {
    return verdict === "changed";
  }
  return md5(await fs.readFile(fullPath)) !== entry!.md5;
}

/**
 * Collects the local versions of files a pull is about to change, and settles
 * them afterwards.
 */
export class LocalChangeGuard {
  private readonly protectedFiles: ProtectedFile[] = [];
  readonly backupRoot: string;

  constructor(
    private readonly workspaceRoot: string,
    label: string,
  ) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.backupRoot = path.join(
      workspaceRoot,
      ".checkpoint",
      BACKUP_DIR,
      `${stamp}-${label}`,
    );
  }

  get files(): readonly ProtectedFile[] {
    return this.protectedFiles;
  }

  /**
   * Backs up `relativePath` if it has local changes. Call before the pull
   * touches the file. Throws if the copy cannot be made: a pull that cannot
   * protect a file must not go ahead.
   */
  async protect(
    relativePath: string,
    kind: IncomingKind,
    entry: WorkspaceStateFile | undefined,
  ): Promise<boolean> {
    const fullPath = resolveInWorkspace(this.workspaceRoot, relativePath);
    if (!(await hasLocalChanges(fullPath, entry))) {
      return false;
    }
    const backupPath = path.join(this.backupRoot, relativePath);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(fullPath, backupPath);
    this.protectedFiles.push({
      relativePath,
      kind,
      baseCl: entry ? entry.changelist : null,
      backupPath,
    });
    return true;
  }

  /**
   * Puts one backed-up file back and forgets it. For a path the pull wrote to
   * but should not have: once the workspace copy has been corrected, the local
   * version simply goes back on top. Returns false if the path had no backup.
   */
  async putBack(relativePath: string): Promise<boolean> {
    const index = this.protectedFiles.findIndex(
      (f) => f.relativePath === relativePath,
    );
    if (index < 0) {
      return false;
    }
    const [file] = this.protectedFiles.splice(index, 1);
    const fullPath = resolveInWorkspace(this.workspaceRoot, file!.relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.copyFile(file!.backupPath, fullPath);
    await this.removeBackups([file!.backupPath]);
    return true;
  }

  /**
   * Puts every backed-up file back where it was. For a pull that failed: the
   * workspace state was not advanced, so the local versions belong in place.
   */
  async restoreAll(): Promise<void> {
    for (const file of this.protectedFiles) {
      const fullPath = resolveInWorkspace(
        this.workspaceRoot,
        file.relativePath,
      );
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.copyFile(file.backupPath, fullPath);
    }
    await this.removeBackups(this.protectedFiles.map((f) => f.backupPath));
  }

  /**
   * Settles every backed-up file against what the pull left in the workspace.
   *
   * @param isBinary  whether a path is binary by the repo's extension list
   * @param readBase  reads a file's content at the changelist the local copy
   *                  was based on (the merge's common ancestor)
   */
  async resolve(
    isBinary: (relativePath: string) => boolean,
    readBase: (relativePath: string, changelist: number) => Promise<Buffer>,
  ): Promise<ResolveResult> {
    const result: ResolveResult = { merged: [], setAside: [] };
    const settled: string[] = [];

    for (const file of this.protectedFiles) {
      const fullPath = resolveInWorkspace(
        this.workspaceRoot,
        file.relativePath,
      );
      const mine = await fs.readFile(file.backupPath);

      if (file.kind === "removed") {
        if (existsSync(fullPath)) {
          // The pull did not delete it after all (filtered out, say). The
          // local file is untouched, so the copy is redundant.
          settled.push(file.backupPath);
        } else {
          result.setAside.push({
            relativePath: file.relativePath,
            backupPath: file.backupPath,
            reason: "deleted-on-server",
          });
        }
        continue;
      }

      let theirs: Buffer;
      let theirsStat;
      try {
        theirs = await fs.readFile(fullPath);
        theirsStat = await fs.stat(fullPath);
      } catch {
        // The pull left nothing here. Put the local version back.
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.copyFile(file.backupPath, fullPath);
        settled.push(file.backupPath);
        continue;
      }

      if (theirs.equals(mine)) {
        // Either the pull did not touch the file, or the local change was the
        // same change. Nothing local is missing from the workspace.
        settled.push(file.backupPath);
        continue;
      }

      const setAside = (reason: SetAsideReason) =>
        result.setAside.push({
          relativePath: file.relativePath,
          backupPath: file.backupPath,
          reason,
        });

      if (isBinary(file.relativePath)) {
        setAside("binary");
        continue;
      }
      if (file.baseCl === null) {
        setAside("no-common-base");
        continue;
      }
      if (!isMergeableText(mine) || !isMergeableText(theirs)) {
        setAside("not-text");
        continue;
      }

      try {
        const base = await readBase(file.relativePath, file.baseCl);
        if (!isMergeableText(base)) {
          setAside("not-text");
          continue;
        }
        const merge = autoMergeText(
          base.toString("utf8"),
          mine.toString("utf8"),
          theirs.toString("utf8"),
        );
        await fs.writeFile(fullPath, merge.content, "utf8");
        result.merged.push({
          relativePath: file.relativePath,
          clean: merge.clean,
          incoming: {
            size: theirsStat.size,
            mtime: theirsStat.mtimeMs,
            md5: md5(theirs),
          },
        });
        if (merge.clean) {
          // Everything in the local version is in the merged file.
          settled.push(file.backupPath);
        }
        // A conflicted merge keeps its backup: the markers hold both sides,
        // but a slip while resolving them should not cost the original.
      } catch {
        // The server's version is still in the workspace, untouched.
        setAside("merge-failed");
      }
    }

    await this.removeBackups(settled);
    return result;
  }

  private async removeBackups(backupPaths: string[]): Promise<void> {
    for (const backupPath of backupPaths) {
      await fs.rm(backupPath, { force: true });
    }
    // Drop the folder (and its parents up to the backup root) once empty.
    await removeEmptyDirs(this.backupRoot);
  }
}

/** Removes `dir` and any of its subdirectories that contain no files. */
async function removeEmptyDirs(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  let empty = true;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!(await removeEmptyDirs(path.join(dir, entry.name)))) {
        empty = false;
      }
    } else {
      empty = false;
    }
  }
  if (empty) {
    await fs.rmdir(dir).catch(() => undefined);
  }
  return empty;
}

const REASON_TEXT: Record<SetAsideReason, string> = {
  binary: "binary file changed on both sides",
  "not-text": "not mergeable as text",
  "no-common-base": "added on both sides",
  "merge-failed": "merge failed",
  "deleted-on-server": "deleted on the server",
};

export function describeSetAside(file: SetAsideFile): string {
  return `${file.relativePath} (${REASON_TEXT[file.reason]}; your version is at ${file.backupPath})`;
}
