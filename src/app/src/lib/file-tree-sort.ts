// MIRROR: the desktop client's copy is
// src/clients/desktop/src/renderer/components/file-tree-sort.ts. The app cannot
// depend on shared packages (see src/lib/issue-refs.ts for why), so this pure
// module is duplicated here. Keep the two in sync.
//
// Every file tree in Checkpoint shows directories above files, whatever sort is
// applied, so a tree reads the same way in the web app and the desktop client.

/** Natural, case-insensitive name ordering, so "file2" lands before "file10". */
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Name ordering on its own, for listings that already separate dirs from files. */
export function compareNames(a: string, b: string): number {
  const byLocale = nameCollator.compare(a, b);
  if (byLocale !== 0) {
    return byLocale;
  }
  // The collator ignores case, so two names differing only in case would
  // otherwise sit in whatever order the source happened to produce.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparator for tree levels: directories first, then name. */
export function compareTreeEntries(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean },
): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return compareNames(a.name, b.name);
}

/**
 * Comparator for a flat list of full paths, ordering it the way the same paths
 * would read as a tree: inside any directory, subdirectory contents come before
 * that directory's own files, then name order.
 *
 * A plain `path` sort interleaves the two, because it compares "/" against
 * whatever character follows a sibling file's stem.
 */
export function compareTreePaths(a: string, b: string): number {
  const aParts = a.split("/");
  const bParts = b.split("/");
  const shared = Math.min(aParts.length, bParts.length);

  for (let i = 0; i < shared; i++) {
    // A part that is not the last one is a directory at this level.
    const aIsFile = i === aParts.length - 1;
    const bIsFile = i === bParts.length - 1;
    if (aIsFile !== bIsFile) {
      return aIsFile ? 1 : -1;
    }

    const byName = compareNames(aParts[i]!, bParts[i]!);
    if (byName !== 0) {
      return byName;
    }
  }

  return aParts.length - bParts.length;
}
