/**
 * Shared file-tree ordering rules.
 *
 * Every tree in the app shows directories above files, whatever column sort the
 * user has applied, so the workspace explorer (a DataTable tree) and the
 * pending-changes tree (hand-rolled) read the same way.
 *
 * The comparators below are mirrored in the web app at
 * src/app/src/lib/file-tree-sort.ts, which cannot depend on shared packages, so
 * a tree reads the same way in both clients. Keep the two in sync;
 * treeSortFields is desktop-only.
 */

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

/**
 * Hidden sort keys for a table row: a directories-first rank and the name to
 * break ties with. The workspace explorer pins sorts on these around whatever
 * column the user picks.
 */
export function treeSortFields(
  name: string,
  isDirectory: boolean,
): { dirRank: number; sortName: string } {
  return { dirRank: isDirectory ? 0 : 1, sortName: name };
}

/** Comparator for hand-rolled trees: directories first, then name. */
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
