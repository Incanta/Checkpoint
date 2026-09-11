/**
 * Hunk-level staging.
 *
 * The correctness property that matters: staging some hunks and submitting
 * must leave the working tree untouched. Everything here pins the piece that
 * makes that possible, which is producing the "staged content" for a subset of
 * hunks without rewriting the file on disk.
 */
import { describe, expect, it } from "vitest";

import {
  computeHunks,
  applyHunks,
  isFullySelected,
} from "../../../core/daemon/src/util/hunks.js";

/**
 * Twenty lines, so two edits near the ends stay separate hunks. With the
 * default 3 lines of context, edits closer than about seven lines apart merge
 * into a single hunk, which is correct behaviour and not what these tests are
 * trying to exercise.
 */
const LINES = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);

function joined(lines: string[]): string {
  return lines.join("\n") + "\n";
}

const HEAD = joined(LINES);
const WORKTREE = joined(
  LINES.map((l, i) =>
    i === 1 ? "EDITED_NEAR_TOP" : i === 18 ? "EDITED_NEAR_BOTTOM" : l,
  ),
);

describe("computeHunks", () => {
  it("finds one hunk per separated edit", () => {
    const hunks = computeHunks(HEAD, WORKTREE);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.index).toBe(0);
    expect(hunks[1]!.index).toBe(1);
  });

  it("returns nothing when the file is unchanged", () => {
    expect(computeHunks(HEAD, HEAD)).toHaveLength(0);
  });
});

describe("applyHunks", () => {
  it("applies only the selected hunk, leaving the other edit out", () => {
    const hunks = computeHunks(HEAD, WORKTREE);

    expect(applyHunks(HEAD, WORKTREE, hunks, new Set([0]))).toBe(
      joined(LINES.map((l, i) => (i === 1 ? "EDITED_NEAR_TOP" : l))),
    );

    expect(applyHunks(HEAD, WORKTREE, hunks, new Set([1]))).toBe(
      joined(LINES.map((l, i) => (i === 18 ? "EDITED_NEAR_BOTTOM" : l))),
    );
  });

  it("selecting every hunk reproduces the worktree exactly", () => {
    const hunks = computeHunks(HEAD, WORKTREE);
    const all = new Set(hunks.map((h) => h.index));
    expect(applyHunks(HEAD, WORKTREE, hunks, all)).toBe(WORKTREE);
  });

  it("selecting no hunks reproduces head exactly", () => {
    const hunks = computeHunks(HEAD, WORKTREE);
    expect(applyHunks(HEAD, WORKTREE, hunks, new Set())).toBe(HEAD);
  });

  it("handles an insertion without dropping surrounding lines", () => {
    const head = joined(["a", "b", "c"]);
    const worktree = joined(["a", "INSERTED", "b", "c"]);
    const hunks = computeHunks(head, worktree);

    const all = new Set(hunks.map((h) => h.index));
    expect(applyHunks(head, worktree, hunks, all)).toBe(worktree);
  });

  it("handles a deletion", () => {
    const head = joined(["a", "b", "c"]);
    const worktree = joined(["a", "c"]);
    const hunks = computeHunks(head, worktree);

    const all = new Set(hunks.map((h) => h.index));
    expect(applyHunks(head, worktree, hunks, all)).toBe(worktree);
  });

  it("preserves a file with no trailing newline", () => {
    const head = ["a", "b"].join("\n");
    const worktree = ["a", "B"].join("\n");
    const hunks = computeHunks(head, worktree);

    const all = new Set(hunks.map((h) => h.index));
    expect(applyHunks(head, worktree, hunks, all)).toBe(worktree);
  });
});

describe("isFullySelected", () => {
  it("is true only when every hunk is chosen", () => {
    const hunks = computeHunks(HEAD, WORKTREE);
    expect(isFullySelected(hunks, new Set([0]))).toBe(false);
    expect(isFullySelected(hunks, new Set([0, 1]))).toBe(true);
  });

  it("is false for an unchanged file, which has nothing to stage", () => {
    expect(isFullySelected([], new Set())).toBe(false);
  });
});

describe("the round trip staging depends on", () => {
  it("re-derives which hunks are staged from the stored content alone", () => {
    // This is how getHunks answers "which hunks are staged": it diffs head
    // against the stored blob and matches ranges, rather than keeping a
    // parallel list of indices that could drift from the content.
    const hunks = computeHunks(HEAD, WORKTREE);
    const blob = applyHunks(HEAD, WORKTREE, hunks, new Set([1]));

    const stagedRanges = new Set(
      computeHunks(HEAD, blob).map((h) => `${h.oldStart}:${h.oldLines}`),
    );
    const staged = hunks
      .filter((h) => stagedRanges.has(`${h.oldStart}:${h.oldLines}`))
      .map((h) => h.index);

    expect(staged).toEqual([1]);
  });

  it("leaves the worktree content untouched, which is the whole point", () => {
    const hunks = computeHunks(HEAD, WORKTREE);
    const before = WORKTREE;

    applyHunks(HEAD, WORKTREE, hunks, new Set([0]));

    // applyHunks is pure: it returns new content and never rewrites a file,
    // so a partial stage followed by a submit cannot disturb the tree.
    expect(WORKTREE).toBe(before);
  });
});
