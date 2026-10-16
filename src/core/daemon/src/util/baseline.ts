import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { WorkspaceStateFile } from "@checkpointvcs/common";

// Deciding whether a file on disk still matches what the workspace state
// recorded for it (its baseline), from the cheapest evidence available.
//
// The state records a size, an mtime, and sometimes a content hash. The hash
// is deferred after a pull, because hashing every pulled file would make large
// syncs much slower, so often there is only size and mtime to go on.
//
// One rule decides this for both change detection (what shows as pending) and
// the pull (what needs protecting), so the two cannot disagree about whether a
// file has local changes.

export type BaselineVerdict =
  /** Provably the same file. */
  | "unchanged"
  /** Different, or not provably the same. */
  | "changed"
  /** Same size but written since; the recorded hash will settle it. */
  | "compare-hash";

export interface BaselineOptions {
  /**
   * What to answer when the baseline has neither an mtime nor a hash, so
   * there is nothing but size to compare. State written by old versions looks
   * like this for every file. Change detection answers "unchanged" (or every
   * file in such a workspace would show as modified); the pull answers
   * "changed" (copying a file it did not need to is cheap).
   */
  whenUnknowable: "unchanged" | "changed";
}

/**
 * How close to the moment a baseline was recorded a file's mtime must be for
 * equal size and mtime to prove nothing: the coarsest filesystem timestamp
 * tick in use (FAT32 counts in 2 seconds; exFAT and HFS+ are coarse too).
 */
export const RACY_WINDOW_MS = 2000;

/** Whether a baseline's file was written too close to its recording to trust. */
export function isRacilyClean(baseline: WorkspaceStateFile): boolean {
  return (
    baseline.recordedAt !== undefined &&
    !!baseline.mtime &&
    baseline.mtime >= baseline.recordedAt - RACY_WINDOW_MS
  );
}

export function compareWithBaseline(
  stat: { size: number; mtimeMs: number },
  baseline: WorkspaceStateFile | undefined,
  options: BaselineOptions,
): BaselineVerdict {
  if (!baseline) {
    return "changed"; // Not tracked at all.
  }
  if (stat.size !== baseline.size) {
    return "changed";
  }

  const sameMtime = !!baseline.mtime && stat.mtimeMs === baseline.mtime;
  // Racily clean: written within one timestamp tick of when the baseline was
  // recorded. A same-size rewrite in that tick keeps the same mtime, so equal
  // size and mtime prove nothing and only the content can tell (git's
  // "racy git" problem).
  const racy = isRacilyClean(baseline);

  if (baseline.md5 !== "") {
    // Not written since the hash was taken means the same content. Otherwise
    // (a different mtime, or none recorded) the content decides.
    return sameMtime && !racy ? "unchanged" : "compare-hash";
  }

  if (sameMtime) {
    // Recording hashes racily clean files (see stampBaselines), so one with
    // no hash is unknowable: the safe answer is that it changed.
    return racy ? "changed" : "unchanged";
  }
  if (!baseline.mtime) {
    return options.whenUnknowable;
  }

  // Same size, written since the baseline, and no hash to compare with. This
  // case used to be answered by hashing the file as it is now and adopting
  // that as the baseline, which turned every same-size edit into "unchanged":
  // the edit left the pending list and the next pull overwrote it. A file that
  // was merely touched now shows as modified until it is reverted, which is
  // the safe way to be wrong.
  return "changed";
}

/**
 * The time by the workspace filesystem's own clock, as git takes its index
 * file's mtime: touching a file and reading its mtime back accounts for a
 * coarse timestamp tick and for a network drive whose clock is not this
 * machine's.
 */
async function filesystemNow(root: string): Promise<number> {
  const marker = path.join(root, ".checkpoint", "racy-clock");
  try {
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "");
    return (await fs.stat(marker)).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Stamps baselines about to be recorded with the time of recording, and
 * hashes the racily clean ones: files written within one timestamp tick of
 * now, whose size and mtime will not prove later that they are unchanged.
 * That is only the files an operation wrote in its last moments, so most
 * pulled files still go unhashed. A file that no longer matches the size and
 * mtime its entry was given is left unhashed, so it shows as changed.
 */
export async function stampBaselines(
  root: string,
  files: Record<string, WorkspaceStateFile>,
): Promise<void> {
  // Every entry written is a baseline recorded now, including ones copied
  // from an older entry with new stats.
  const paths = Object.keys(files);
  if (paths.length === 0) return;
  const recordedAt = await filesystemNow(root);
  const racy: string[] = [];
  for (const p of paths) {
    const stamped = { ...files[p]!, recordedAt };
    files[p] = stamped;
    if (stamped.md5 === "" && isRacilyClean(stamped)) racy.push(p);
  }
  const BATCH = 32;
  for (let i = 0; i < racy.length; i += BATCH) {
    await Promise.all(
      racy.slice(i, i + BATCH).map(async (p) => {
        const entry = files[p]!;
        try {
          const full = path.join(root, p);
          const stat = await fs.stat(full);
          if (stat.size !== entry.size || stat.mtimeMs !== entry.mtime) return;
          const hash = createHash("md5")
            .update(await fs.readFile(full))
            .digest("hex");
          files[p] = { ...entry, md5: hash };
        } catch {
          // Gone or unreadable: no hash, so it shows as changed.
        }
      }),
    );
  }
}
