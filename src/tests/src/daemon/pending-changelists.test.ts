/**
 * Cover for the workspace's numbered pending changelists: the local store,
 * and the rule deciding which changelist a staged file is in (which is also
 * what a submit sends, so a wrong answer submits the wrong files).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assignToPendingChangelist,
  changelistOf,
  completePendingChangelistSubmit,
  createPendingChangelist,
  deletePendingChangelist,
  destinedBranch,
  getPendingChangelist,
  getPendingChangelists,
  setDefaultChangelistDescription,
  updatePendingChangelistDescription,
} from "../../../core/daemon/src/util/pending-changelists.js";
import {
  FileStatus,
  FileType,
  type File,
  type FileClaimInfo,
} from "../../../core/daemon/src/types/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "chk-pending-cl-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function file(p: string, claimBranches: string[] = []): File {
  return {
    path: p,
    type: FileType.Text,
    size: 1,
    modifiedAt: 0,
    status: FileStatus.ChangedCheckedOut,
    id: null,
    changelist: null,
    claims: claimBranches.map(
      (branchName, i) =>
        ({
          id: `c${i}`,
          fileId: "f",
          filePath: p,
          strength: "ADVISORY",
          state: i === 0 ? "OPEN" : "SUBMITTED",
          branchName,
          domainBranchName: "main",
          blocking: false,
          workspaceId: "ws",
          userId: "u",
          user: { email: "e" },
        }) as unknown as FileClaimInfo,
    ),
    staged: true,
  };
}

describe("pending changelist store", () => {
  it("starts empty when nothing was ever stored", async () => {
    expect(await getPendingChangelists(root)).toEqual({
      changelists: [],
      assignments: {},
      defaultDescriptions: {},
    });
  });

  it("starts empty when the file is unreadable rather than failing", async () => {
    await mkdir(path.join(root, ".checkpoint"), { recursive: true });
    await writeFile(
      path.join(root, ".checkpoint", "pending-changelists.json"),
      "{ not json",
    );
    expect((await getPendingChangelists(root)).changelists).toEqual([]);
    // And it is writable again after.
    const cl = await createPendingChangelist(root, "main", "after");
    expect(cl.id).toBe(1);
  });

  it("numbers changelists in order and never reuses a deleted id", async () => {
    const a = await createPendingChangelist(root, "main", "a");
    const b = await createPendingChangelist(root, "main", "b");
    await deletePendingChangelist(root, b.id);
    const c = await createPendingChangelist(root, "main", "c");
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect(
      (await getPendingChangelists(root)).changelists.map((x) => x.id),
    ).toEqual([1, 3]);
  });

  it("loses no update when edits arrive at once", async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createPendingChangelist(root, "main", `cl ${i}`),
      ),
    );
    expect(new Set(created.map((c) => c.id)).size).toBe(20);
    expect((await getPendingChangelists(root)).changelists).toHaveLength(20);
  });

  it("refuses to assign into a changelist that does not exist", async () => {
    await expect(
      assignToPendingChangelist(root, ["a.txt"], 42),
    ).rejects.toThrow(/42/);
    expect((await getPendingChangelists(root)).assignments).toEqual({});
  });

  it("moves paths between changelists and back to the default", async () => {
    const one = await createPendingChangelist(root, "main", "");
    const two = await createPendingChangelist(root, "main", "");
    await assignToPendingChangelist(root, ["a", "b"], one.id);
    await assignToPendingChangelist(root, ["b"], two.id);
    expect((await getPendingChangelists(root)).assignments).toEqual({
      a: one.id,
      b: two.id,
    });
    await assignToPendingChangelist(root, ["a"], null);
    expect((await getPendingChangelists(root)).assignments).toEqual({
      b: two.id,
    });
  });

  it("returns a deleted changelist's files to the default", async () => {
    const keep = await createPendingChangelist(root, "main", "");
    const gone = await createPendingChangelist(root, "main", "");
    await assignToPendingChangelist(root, ["a"], keep.id);
    await assignToPendingChangelist(root, ["b", "c"], gone.id);
    await deletePendingChangelist(root, gone.id);
    expect((await getPendingChangelists(root)).assignments).toEqual({
      a: keep.id,
    });
  });

  it("edits descriptions, and clears a default one set to empty", async () => {
    const cl = await createPendingChangelist(root, "main", "first");
    await updatePendingChangelistDescription(root, cl.id, "second");
    expect((await getPendingChangelist(root, cl.id)).description).toBe(
      "second",
    );
    await expect(
      updatePendingChangelistDescription(root, 99, "x"),
    ).rejects.toThrow();

    await setDefaultChangelistDescription(root, "main", "draft");
    expect((await getPendingChangelists(root)).defaultDescriptions).toEqual({
      main: "draft",
    });
    await setDefaultChangelistDescription(root, "main", "");
    expect((await getPendingChangelists(root)).defaultDescriptions).toEqual({});
  });

  it("submitting a numbered changelist deletes it and only its files", async () => {
    const sent = await createPendingChangelist(root, "main", "sent");
    const other = await createPendingChangelist(root, "main", "other");
    await assignToPendingChangelist(root, ["a", "b"], sent.id);
    await assignToPendingChangelist(root, ["c"], other.id);
    await setDefaultChangelistDescription(root, "main", "default draft");

    // "b" stays assigned in the store unless submitted, but its changelist
    // is gone, so it must not linger pointing at a dead id.
    await completePendingChangelistSubmit(root, ["a"], { id: sent.id });

    const state = await getPendingChangelists(root);
    expect(state.changelists.map((c) => c.id)).toEqual([other.id]);
    expect(state.assignments).toEqual({ c: other.id });
    expect(state.defaultDescriptions).toEqual({ main: "default draft" });
  });

  it("submitting a default changelist clears its draft, nothing else", async () => {
    const cl = await createPendingChangelist(root, "main", "");
    await assignToPendingChangelist(root, ["c"], cl.id);
    await setDefaultChangelistDescription(root, "main", "main draft");
    await setDefaultChangelistDescription(root, "feature", "feature draft");

    await completePendingChangelistSubmit(root, ["a"], { defaultOf: "main" });

    const state = await getPendingChangelists(root);
    expect(state.changelists).toHaveLength(1);
    expect(state.assignments).toEqual({ c: cl.id });
    expect(state.defaultDescriptions).toEqual({ feature: "feature draft" });
  });
});

describe("which changelist a staged file is in", () => {
  it("goes to the domain root with no claim, else to its open claim's branch", () => {
    expect(destinedBranch(file("a"), "main")).toBe("main");
    expect(destinedBranch(file("a", ["feature"]), "main")).toBe("feature");
    // Only a submitted claim: where earlier work went (a parent in a stack).
    const submittedOnly = file("a", ["x", "parent"]);
    submittedOnly.claims = [submittedOnly.claims[1]!];
    expect(destinedBranch(submittedOnly, "main")).toBe("parent");
  });

  it("is the default when unassigned", async () => {
    const state = await getPendingChangelists(root);
    expect(changelistOf(file("a"), state, "main")).toBeNull();
  });

  it("is the assigned changelist when it targets the file's branch", async () => {
    const cl = await createPendingChangelist(root, "feature", "");
    await assignToPendingChangelist(root, ["a"], cl.id);
    const state = await getPendingChangelists(root);
    expect(changelistOf(file("a", ["feature"]), state, "main")).toBe(cl.id);
  });

  it("falls back to the default when the claim moved to another branch", async () => {
    // Assigned while claimed on main, then the claim moved: submitting the
    // changelist must not send a file now destined elsewhere.
    const cl = await createPendingChangelist(root, "main", "");
    await assignToPendingChangelist(root, ["a"], cl.id);
    const state = await getPendingChangelists(root);
    expect(changelistOf(file("a", ["feature"]), state, "main")).toBeNull();
  });

  it("falls back to the default when the assignment names a missing changelist", () => {
    const state = {
      changelists: [],
      assignments: { a: 7 },
      defaultDescriptions: {},
    };
    expect(changelistOf(file("a"), state, "main")).toBeNull();
  });
});
