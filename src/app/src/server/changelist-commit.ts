// Shared rules for committing a changelist: what counts as losing a race (and
// is worth another attempt), and what counts as a submitter's file being out
// of date (and is not).

/**
 * How many times one submit is rebuilt against a head that keeps moving
 * before it is reported as a conflict. Every attempt that loses does so to a
 * submit that won, so N submits arriving together need at most N attempts.
 */
export const MAX_SUBMIT_ATTEMPTS = 16;

/** Thrown inside a commit transaction when its premise no longer holds. */
export class SubmitContention extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmitContention";
  }
}

/**
 * True when a failed commit lost a race and can be retried from the top,
 * rather than failed for a reason a retry would only repeat.
 */
export function isSubmitContention(error: unknown): boolean {
  if (error instanceof SubmitContention) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? "");

  // Another submit took the changelist number this attempt chose. Only that
  // index counts: a unique violation anywhere else (a file claim, say) is a
  // real failure that must surface as itself.
  if (code === "P2002") {
    const meta = (error as { meta?: { modelName?: unknown; target?: unknown } })
      .meta;
    const target = Array.isArray(meta?.target)
      ? meta.target.join(",")
      : String(meta?.target ?? "");
    return (
      meta?.modelName === "Changelist" ||
      /Changelist_repoId_number|repoId,number/.test(target)
    );
  }

  // Write conflict or deadlock between transactions; the transaction could
  // not be started or timed out waiting on a lock.
  if (code === "P2034" || code === "P2028" || code === "P1008") {
    return true;
  }

  // SQLite reports a busy writer as a message, not a code.
  return /database is locked|SQLITE_BUSY/i.test(message);
}

export interface BaseConflict {
  path: string;
  /** What the submitter's copy came from; null if it believed the file new. */
  base: number | null;
  /** The changelist holding the file at the branch head; null if absent. */
  head: number | null;
}

/**
 * Finds files a submit would change without having seen the version it is
 * replacing.
 *
 * `headPaths` maps each path at the branch head to the changelist that last
 * wrote it. A modification says what the submitter's copy came from in
 * `baseChangelist`: a changelist number, or null for a file it believes is new
 * to the branch. If that is not the changelist the head has for the path,
 * someone else's change landed in between and the submit would silently
 * discard it.
 *
 * A modification with no `baseChangelist` at all is not checked. Callers that
 * cannot name a comparable base (older clients, a file carried from one branch
 * to another) leave it out.
 */
export function findBaseConflicts(
  modifications: readonly {
    path: string;
    delete: boolean;
    baseChangelist?: number | null;
  }[],
  headPaths: ReadonlyMap<string, number>,
): BaseConflict[] {
  const conflicts: BaseConflict[] = [];
  const seen = new Set<string>();

  for (const mod of modifications) {
    if (mod.baseChangelist === undefined) {
      continue;
    }
    const path = mod.path.replaceAll("\\", "/");
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);

    const base = mod.baseChangelist;
    const head = headPaths.get(path) ?? null;

    // Deleting a file that is already gone changes nothing, whoever removed it.
    if (mod.delete && head === null) {
      continue;
    }

    if (head !== base) {
      conflicts.push({ path, base, head });
    }
  }

  return conflicts;
}

const MAX_LISTED_CONFLICTS = 50;

export function describeBaseConflicts(
  branchName: string,
  conflicts: readonly BaseConflict[],
): string {
  const lines = conflicts.slice(0, MAX_LISTED_CONFLICTS).map((c) => {
    const yours =
      c.base === null ? "you added it as new" : `yours is from #${c.base}`;
    const theirs =
      c.head === null
        ? "it was deleted on the branch"
        : `the branch has #${c.head}`;
    return `${c.path} (${yours}; ${theirs})`;
  });
  if (conflicts.length > MAX_LISTED_CONFLICTS) {
    lines.push(`and ${conflicts.length - MAX_LISTED_CONFLICTS} more`);
  }
  const noun = conflicts.length === 1 ? "file" : "files";
  return (
    `Cannot submit: ${conflicts.length} ${noun} changed on "${branchName}" since this workspace last synced. ` +
    `Nothing was submitted. Pull, resolve any conflicts, and submit again:\n` +
    lines.join("\n")
  );
}
