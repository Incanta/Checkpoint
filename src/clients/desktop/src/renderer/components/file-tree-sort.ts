import type { TreeTableSortMeta } from "primereact/treetable";

/**
 * Shared file-tree ordering rules.
 *
 * Every tree in the app shows directories above files, whatever column sort the
 * user has applied, so the workspace explorer (a PrimeReact TreeTable) and the
 * pending-changes tree (hand-rolled) read the same way.
 */

/** Natural, case-insensitive name ordering, so "file2" lands before "file10". */
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

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
  return nameCollator.compare(a.name, b.name);
}
