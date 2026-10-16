import { promises as fs } from "fs";
import path from "path";

// What the native pull reports it wrote (see tracking-storage.h in the
// longtail wrapper): each file's size and mtime the moment its write closed,
// and the permissions it applied. Recording these, rather than stat-ing every
// pulled file when the pull returns, keeps an edit made to an early file
// while a long pull runs from being recorded as the version the pull wrote.
// Addons from before it write nothing, and the pull stats the files itself.

export interface WrittenFile {
  size: number;
  /** As Node's fs.stat reports it, so later comparisons are exact. */
  mtimeMs: number;
  /** Permission bits the pull applied, when it applied any. */
  mode?: number;
}

const RECORD = path.join(".checkpoint", "pull-written.tsv");

/** Removes any record left from an earlier pass, before a native pass. */
export async function clearPullRecord(root: string): Promise<void> {
  await fs.rm(path.join(root, RECORD), { force: true });
}

/**
 * Reads and removes the record a native pass left, merging it into `into`
 * (a later pass that writes the same file again wins). Returns false when
 * the pass left none.
 */
export async function takePullRecord(
  root: string,
  into: Map<string, WrittenFile>,
): Promise<boolean> {
  const file = path.join(root, RECORD);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }
  await fs.rm(file, { force: true });
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [rel, size, sec, nsec, perms] = line.split("\t");
    if (rel === undefined || nsec === undefined) continue;
    into.set(rel, {
      size: Number(size),
      // Node's own formula (msFromTimeSpec), so the value is bit-identical.
      mtimeMs: Number(sec) * 1e3 + Number(nsec) / 1e6,
      ...(perms !== undefined && perms !== "-" && { mode: parseInt(perms, 8) }),
    });
  }
  return true;
}
