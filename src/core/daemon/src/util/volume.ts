import { promises as fs } from "fs";
import path from "path";

import { foldName } from "./repo-path-rules.js";

// Whether the filesystem under a workspace takes two names for one file.
//
// The server stores paths byte for byte, and the tree can hold two spellings
// of one name ("Content/Hero.txt" and "Content/hero.txt", or "é" as one code
// point and as "e" plus an accent), because repositories hold them from
// before the server refused new ones, and because Linux users can make them.
// On NTFS and APFS (case) and APFS and HFS+ (normalization) both spellings
// are one file, so comparing names byte for byte there takes one file for two:
// a delete of either spelling deletes both, and the scan reports a tracked
// file as deleted plus an untracked one.
//
// The answer is probed on the volume itself rather than read from the OS:
// macOS volumes can be case-sensitive, and so can Windows directories.

export interface VolumeFolds {
  /** "a" and "A" name one file. */
  case: boolean;
  /** "é" (U+00E9) and "e" + U+0301 name one file. */
  normalization: boolean;
}

const probes = new Map<string, Promise<VolumeFolds>>();

async function probe(root: string): Promise<VolumeFolds> {
  const dir = path.join(root, ".checkpoint");
  await fs.mkdir(dir, { recursive: true });
  const probeDir = await fs.mkdtemp(path.join(dir, "fold-probe-"));
  try {
    await fs.writeFile(path.join(probeDir, "case-Ab"), "");
    await fs.writeFile(path.join(probeDir, "nfc-café"), "");
    const exists = (name: string) =>
      fs.stat(path.join(probeDir, name)).then(
        () => true,
        () => false,
      );
    return {
      case: await exists("case-aB"),
      normalization: await exists("nfc-café"),
    };
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
}

/** How the volume under `root` compares names (probed once per process). */
export function volumeFolds(root: string): Promise<VolumeFolds> {
  const key = path.resolve(root);
  let pending = probes.get(key);
  if (!pending) {
    pending = probe(key).catch(() => ({ case: false, normalization: false }));
    probes.set(key, pending);
  }
  return pending;
}

/** Forgets cached probes (tests, or a workspace moved to another volume). */
export function clearVolumeProbes(): void {
  probes.clear();
}

export type PathKey = (relativePath: string) => string;

/**
 * The key under which two repo paths name the same file on such a volume, or
 * null when the volume tells every spelling apart.
 */
export function pathKeyFor(folds: VolumeFolds): PathKey | null {
  if (folds.case) {
    return (p) => p.split("/").map(foldName).join("/");
  }
  if (folds.normalization) {
    return (p) => p.normalize("NFC");
  }
  return null;
}

/** pathKeyFor the volume under `root`. */
export async function workspacePathKey(root: string): Promise<PathKey | null> {
  return pathKeyFor(await volumeFolds(root));
}

/** Groups paths by key: each key's spellings, in the order given. */
export function groupByKey(
  paths: Iterable<string>,
  key: PathKey,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    const k = key(p);
    const list = out.get(k);
    if (list) list.push(p);
    else out.set(k, [p]);
  }
  return out;
}
