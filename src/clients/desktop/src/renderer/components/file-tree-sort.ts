import type { TreeTableSortMeta } from "primereact/treetable";

/**
 * Shared file-tree ordering rules.
 *
 * Every tree in the app shows directories above files, whatever column sort the
 * user has applied, so the workspace explorer (a PrimeReact TreeTable) and the
 * pending-changes tree (hand-rolled) read the same way.
 *
 * The comparators below are mirrored in the web app at
 * src/app/src/lib/file-tree-sort.ts, which cannot depend on shared packages, so
 * a tree reads the same way in both clients. Keep the two in sync; the
 * TreeTable helpers further down are desktop-only.
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
 * Hidden sort fields carried on TreeTable node data. Neither is a column, so
 * anything else in a sort event came from the user clicking a header.
 */
const DIR_RANK_FIELD = "dirRank";
const SORT_NAME_FIELD = "sortName";

/** Primary criterion: directories (rank 0) above files (rank 1). */
const DIRECTORIES_FIRST: TreeTableSortMeta = {
  field: DIR_RANK_FIELD,
  order: 1,
};

/** Last criterion, so rows the sorted column can't separate stay name-ordered. */
const BY_NAME: TreeTableSortMeta = { field: SORT_NAME_FIELD, order: 1 };

/** The hidden sort fields to spread into a TreeTable node's `data`. */
export function treeSortFields(
  name: string,
  isDirectory: boolean,
): { dirRank: number; sortName: string } {
  return { dirRank: isDirectory ? 0 : 1, sortName: name };
}

/** Wrap the user's column sorts so directories stay on top and ties fall back to the name. */
export function withDirectoriesFirst(
  userSortMeta: TreeTableSortMeta[],
): TreeTableSortMeta[] {
  return [DIRECTORIES_FIRST, ...userSortMeta, BY_NAME];
}

/** Strip our injected criteria from a sort event, leaving only what the user clicked. */
export function extractUserSortMeta(
  multiSortMeta: TreeTableSortMeta[] | undefined | null,
): TreeTableSortMeta[] {
  return (multiSortMeta ?? []).filter(
    (meta) => meta.field !== DIR_RANK_FIELD && meta.field !== SORT_NAME_FIELD,
  );
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
