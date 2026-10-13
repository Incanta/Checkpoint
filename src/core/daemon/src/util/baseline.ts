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

  if (baseline.md5 !== "") {
    // Not written since the hash was taken means the same content. Otherwise
    // (a different mtime, or none recorded) the content decides.
    return sameMtime ? "unchanged" : "compare-hash";
  }

  if (sameMtime) {
    return "unchanged";
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
