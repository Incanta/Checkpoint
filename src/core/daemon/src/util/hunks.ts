import { structuredPatch } from "diff";

/**
 * Hunk-level staging.
 *
 * Checkpoint has no index: submit hands the native addon a `localRootPath` and
 * the addon reads content straight off disk, so "what is submitted" and "what
 * is in the working tree" are the same thing by construction. Staging part of
 * a file needs a third state, which is what an index is.
 *
 * The staged unit here is the RESULTING FILE CONTENT, snapshotted when you
 * stage, not a list of hunk indices. Indices drift the moment the worktree
 * file changes again; a snapshot stays meaningful and gives the honest
 * three-way view (head vs staged vs worktree). This is why git stores blobs
 * rather than patches.
 */

export interface Hunk {
  /** Stable within one diff; used to say which hunks to stage. */
  index: number;
  /** 1-based start line in the head (left) content. */
  oldStart: number;
  oldLines: number;
  /** 1-based start line in the worktree (right) content. */
  newStart: number;
  newLines: number;
  /** Unified-diff lines, each prefixed with " ", "-" or "+". */
  lines: string[];
}

const NEWLINE = /\r?\n/;

/** Splits content into lines, remembering whether it ended with a newline. */
function splitLines(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(NEWLINE);
  // A trailing newline yields a final empty element that is not a real line.
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

/** Computes the hunks between head content and worktree content. */
export function computeHunks(head: string, worktree: string): Hunk[] {
  const patch = structuredPatch("head", "worktree", head, worktree, "", "", {
    context: 3,
  });

  return patch.hunks.map((h, index) => ({
    index,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
}

/**
 * Produces the content you get by applying only `selected` hunks to `head`.
 *
 * Walks the head line by line, taking worktree lines where a selected hunk
 * covers them and head lines everywhere else. Unselected hunks are simply not
 * applied, so their changes stay in the working tree and out of the submit.
 */
export function applyHunks(
  head: string,
  worktree: string,
  hunks: Hunk[],
  selected: Set<number>,
): string {
  const { lines: headLines, trailingNewline } = splitLines(head);
  const { lines: worktreeLines } = splitLines(worktree);

  const chosen = hunks
    .filter((h) => selected.has(h.index))
    .sort((a, b) => a.oldStart - b.oldStart);

  const out: string[] = [];
  // 0-based cursor into headLines.
  let headCursor = 0;

  for (const hunk of chosen) {
    const hunkHeadStart = hunk.oldStart - 1;

    // Everything before this hunk comes from head unchanged.
    for (; headCursor < hunkHeadStart; headCursor++) {
      out.push(headLines[headCursor]!);
    }

    // The hunk's result is its worktree-side lines.
    const hunkNewStart = hunk.newStart - 1;
    for (let i = 0; i < hunk.newLines; i++) {
      const line = worktreeLines[hunkNewStart + i];
      if (line !== undefined) {
        out.push(line);
      }
    }

    headCursor = hunkHeadStart + hunk.oldLines;
  }

  for (; headCursor < headLines.length; headCursor++) {
    out.push(headLines[headCursor]!);
  }

  return out.join("\n") + (trailingNewline && out.length > 0 ? "\n" : "");
}

/**
 * True when staging these hunks would produce exactly the worktree content,
 * i.e. the file is fully staged and needs no blob of its own.
 */
export function isFullySelected(hunks: Hunk[], selected: Set<number>): boolean {
  return hunks.length > 0 && hunks.every((h) => selected.has(h.index));
}
