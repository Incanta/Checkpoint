// Tests for merging a branch into its target (branch.mergeBranch and
// mergeRequest.merge, which share ~/server/branch-merge).
//
// The merge used to copy the incoming branch's whole tree over the target's.
// Anything that had changed on the target since the branch was cut, and that
// the branch never touched, went back to the branch's older copy: a merge of
// an unrelated one-file branch could silently undo a week of work on main.
// When both sides had changed the same file, the branch's version won without
// a word.
//
// The contract now: a merge takes exactly the changes the branch made, keeps
// everything the target changed, and refuses (changing nothing) when both
// changed the same file differently.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import {
  makeUser,
  makeOrg,
  makeRepo,
  makeWorkspace,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { getStateTreePaths } from "~/server/state-tree";
import { findMergeBase, mergeTrees } from "~/server/branch-merge";
import { resolveFileSource } from "~/server/read-file-at-changelist";
import { restackChildren } from "~/server/claims/domain";

// The real implementation, wrapped so one test can make it fail inside the
// merge transaction.
vi.mock("~/server/claims/domain", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/server/claims/domain")>();
  return { ...actual, restackChildren: vi.fn(actual.restackChildren) };
});

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

const tree = (entries: Record<string, number>) =>
  new Map(Object.entries(entries));

describe("mergeTrees", () => {
  it("takes what only the incoming side changed", () => {
    const result = mergeTrees(
      tree({ "mod.txt": 1, "del.txt": 1, "same.txt": 1 }),
      tree({ "mod.txt": 1, "del.txt": 1, "same.txt": 1 }),
      tree({ "mod.txt": 5, "add.txt": 5, "same.txt": 1 }),
    );

    expect(result.conflicts).toEqual([]);
    expect(Object.fromEntries(result.merged)).toEqual({
      "mod.txt": 5,
      "add.txt": 5,
      "same.txt": 1,
    });
    expect(result.applied).toEqual([
      { path: "add.txt", incoming: 5 },
      { path: "del.txt", incoming: null },
      { path: "mod.txt", incoming: 5 },
    ]);
  });

  it("keeps what only the target side changed", () => {
    // The case the old merge got wrong: none of these were touched by the
    // incoming side, so the target's versions must survive.
    const result = mergeTrees(
      tree({ "mod.txt": 1, "del.txt": 1, "same.txt": 1 }),
      tree({ "mod.txt": 7, "add.txt": 7, "same.txt": 1 }),
      tree({ "mod.txt": 1, "del.txt": 1, "same.txt": 1, "branch.txt": 5 }),
    );

    expect(result.conflicts).toEqual([]);
    expect(Object.fromEntries(result.merged)).toEqual({
      "mod.txt": 7,
      "add.txt": 7,
      "same.txt": 1,
      "branch.txt": 5,
    });
    expect(result.applied).toEqual([{ path: "branch.txt", incoming: 5 }]);
  });

  it("merges changes to different files from both sides", () => {
    const result = mergeTrees(
      tree({ "a.txt": 1, "b.txt": 1, "c.txt": 1, "d.txt": 1 }),
      tree({ "a.txt": 7, "b.txt": 1, "d.txt": 1 }),
      tree({ "a.txt": 1, "b.txt": 5, "c.txt": 1 }),
    );

    expect(result.conflicts).toEqual([]);
    // a: target's edit. b: incoming's edit. c: target deleted. d: incoming deleted.
    expect(Object.fromEntries(result.merged)).toEqual({
      "a.txt": 7,
      "b.txt": 5,
    });
  });

  it("treats both sides deleting a file as agreement", () => {
    const result = mergeTrees(tree({ "gone.txt": 1 }), tree({}), tree({}));
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.merged.size).toBe(0);
  });

  it.each([
    ["both modified", { "f.txt": 1 }, { "f.txt": 7 }, { "f.txt": 5 }, 1, 7, 5],
    [
      "incoming modified, target deleted",
      { "f.txt": 1 },
      {},
      { "f.txt": 5 },
      1,
      null,
      5,
    ],
    [
      "incoming deleted, target modified",
      { "f.txt": 1 },
      { "f.txt": 7 },
      {},
      1,
      7,
      null,
    ],
    ["both added", {}, { "f.txt": 7 }, { "f.txt": 5 }, null, 7, 5],
  ] as const)(
    "reports a conflict when %s",
    (_name, base, target, incoming, b, t, i) => {
      const result = mergeTrees(tree(base), tree(target), tree(incoming));

      expect(result.conflicts).toEqual([
        { path: "f.txt", base: b, target: t, incoming: i },
      ]);
      // A conflicted path is left exactly as the target had it.
      expect(result.merged.get("f.txt") ?? null).toBe(t);
      expect(result.applied).toEqual([]);
    },
  );

  it("reports every conflict and still applies nothing else to conflicted paths", () => {
    const result = mergeTrees(
      tree({ "a.txt": 1, "b.txt": 1, "c.txt": 1 }),
      tree({ "a.txt": 7, "b.txt": 8, "c.txt": 1 }),
      tree({ "a.txt": 5, "b.txt": 6, "c.txt": 6 }),
    );
    expect(result.conflicts.map((c) => c.path)).toEqual(["a.txt", "b.txt"]);
    expect(result.applied).toEqual([{ path: "c.txt", incoming: 6 }]);
  });

  it("does not mutate its inputs", () => {
    const base = tree({ "a.txt": 1 });
    const target = tree({ "a.txt": 1 });
    const incoming = tree({ "a.txt": 5, "b.txt": 5 });
    mergeTrees(base, target, incoming);
    expect(Object.fromEntries(target)).toEqual({ "a.txt": 1 });
    expect(Object.fromEntries(incoming)).toEqual({ "a.txt": 5, "b.txt": 5 });
  });

  it("is a fast-forward when the target has not moved", () => {
    const base = tree({ "a.txt": 1, "b.txt": 1 });
    const incoming = tree({ "a.txt": 5, "c.txt": 6 });
    const result = mergeTrees(base, base, incoming);
    expect(Object.fromEntries(result.merged)).toEqual(
      Object.fromEntries(incoming),
    );
  });
});

describe("branch merge", () => {
  let testDb: TestDb;
  let caller: Caller;
  let repoId: string;
  let workspaceId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    globalThis.__checkpointTestDb = testDb.client;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
    const owner = await makeUser(testDb.client);
    const org = await makeOrg(testDb.client, {
      ownerId: owner.id,
      ownerRole: "ADMIN",
    });
    const repo = await makeRepo(testDb.client, org.id, owner.id);
    const workspace = await makeWorkspace(
      testDb.client,
      repo.id,
      org.id,
      owner.id,
    );
    caller = await makeAppCaller({ asUser: owner });
    repoId = repo.id;
    workspaceId = workspace.id;
  });

  /** Submits to a branch; returns the changelist number. */
  async function submit(
    branchName: string,
    mods: Record<string, "write" | "delete">,
  ): Promise<number> {
    const result = await caller.changelist.createChangelist({
      message: `${branchName}: ${Object.keys(mods).join(", ")}`,
      repoId,
      versionIndex: `${branchName}-${Object.keys(mods).join("-")}.lvi`,
      branchName,
      modifications: Object.entries(mods).map(([path, kind]) => ({
        path,
        delete: kind === "delete",
      })),
      keepCheckedOut: false,
      workspaceId,
    });
    return result.number;
  }

  async function branchFrom(parent: string, name: string) {
    await caller.branch.createBranch({
      repoId,
      name,
      type: "FEATURE",
      parentBranchName: parent,
    });
  }

  async function head(branchName: string): Promise<number> {
    const branch = await testDb.client.branch.findFirstOrThrow({
      where: { repoId, name: branchName },
    });
    return branch.headNumber;
  }

  async function treeOf(branchName: string) {
    return Object.fromEntries(
      await getStateTreePaths(testDb.client, repoId, await head(branchName)),
    );
  }

  const merge = (incoming: string, target = "main") =>
    caller.branch.mergeBranch({
      repoId,
      incomingBranchName: incoming,
      targetBranchName: target,
    });

  async function snapshot() {
    return {
      changelists: await testDb.client.changelist.count({ where: { repoId } }),
      fileChanges: await testDb.client.fileChange.count({ where: { repoId } }),
      branches: (
        await testDb.client.branch.findMany({
          where: { repoId },
          select: { name: true, headNumber: true },
          orderBy: { name: "asc" },
        })
      ).map((b) => `${b.name}@${b.headNumber}`),
    };
  }

  describe("what the merge takes and keeps", () => {
    it("keeps files the target changed after the branch was cut", async () => {
      // The headline regression. main: 1 adds three files. The branch edits
      // one. main then edits another, adds one, and deletes the third.
      const c1 = await submit("main", {
        "shared.txt": "write",
        "main-only.txt": "write",
        "doomed.txt": "write",
      });
      await branchFrom("main", "feature");
      const f = await submit("feature", { "shared.txt": "write" });
      const m1 = await submit("main", { "main-only.txt": "write" });
      const m2 = await submit("main", {
        "new-on-main.txt": "write",
        "doomed.txt": "delete",
      });

      const result = await merge("feature");

      expect(await treeOf("main")).toEqual({
        "shared.txt": f, // the branch's change
        "main-only.txt": m1, // main's later edit, NOT the branch's stale copy
        "new-on-main.txt": m2, // added on main after the cut
        // doomed.txt stays deleted
      });
      expect(await head("main")).toBe(result.mergeChangelist.number);
      expect(c1).toBeLessThan(f);
    });

    it("carries every changelist of a multi-changelist branch when the target has moved on", async () => {
      // The old walk stopped at the first changelist whose parent was numbered
      // at or below the target head, which is the very first one here.
      await submit("main", { "base.txt": "write" });
      await branchFrom("main", "feature");
      const f1 = await submit("feature", { "one.txt": "write" });
      await submit("main", { "main-a.txt": "write" });
      const f2 = await submit("feature", { "two.txt": "write" });
      await submit("main", { "main-b.txt": "write" });
      const f3 = await submit("feature", {
        "three.txt": "write",
        "one.txt": "delete",
      });

      const result = await merge("feature");

      const merged = await treeOf("main");
      expect(merged["two.txt"]).toBe(f2);
      expect(merged["three.txt"]).toBe(f3);
      expect(merged["one.txt"]).toBeUndefined();
      expect(merged["main-a.txt"]).toBeDefined();
      expect(merged["main-b.txt"]).toBeDefined();

      for (const n of [f1, f2, f3]) {
        expect(result.mergeChangelist.message).toContain(`#${n} `);
      }

      const changes = await testDb.client.fileChange.findMany({
        where: { repoId, changelistNumber: result.mergeChangelist.number },
        include: { file: true },
      });
      expect(changes.map((c) => `${c.file.path}:${c.type}`).sort()).toEqual([
        "three.txt:MODIFY",
        "two.txt:MODIFY",
      ]);
    });

    it("applies the branch's deletes and nothing more", async () => {
      await submit("main", { "keep.txt": "write", "drop.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "drop.txt": "delete" });
      const m = await submit("main", { "keep.txt": "write" });

      await merge("feature");

      expect(await treeOf("main")).toEqual({ "keep.txt": m });
    });

    it("merges a branch that only re-did what the target already did", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "a.txt": "delete" });
      await submit("main", { "a.txt": "delete" });

      await merge("feature");
      expect(await treeOf("main")).toEqual({});
    });

    it("is a fast-forward when the target has not moved", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      const f1 = await submit("feature", { "a.txt": "write" });
      const f2 = await submit("feature", { "b.txt": "write" });

      await merge("feature");
      expect(await treeOf("main")).toEqual({ "a.txt": f1, "b.txt": f2 });
    });

    it("deletes the merged branch and parents the merge on the target head", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "b.txt": "write" });
      const targetHead = await submit("main", { "c.txt": "write" });

      const result = await merge("feature");

      expect(result.deletedBranch).toBe("feature");
      expect(
        await testDb.client.branch.findFirst({
          where: { repoId, name: "feature" },
        }),
      ).toBeNull();
      const mergeCl = await testDb.client.changelist.findUniqueOrThrow({
        where: {
          repoId_number: { repoId, number: result.mergeChangelist.number },
        },
      });
      expect(mergeCl.parentNumber).toBe(targetHead);
    });
  });

  describe("conflicts", () => {
    async function expectRefused(mention: string) {
      const before = await snapshot();
      await expect(merge("feature")).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(merge("feature")).rejects.toThrow(mention);
      expect(await snapshot()).toEqual(before);
    }

    it("refuses when both sides modified a file, and changes nothing", async () => {
      await submit("main", { "both.txt": "write", "calm.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "both.txt": "write", "feature.txt": "write" });
      await submit("main", { "both.txt": "write" });

      await expectRefused("both.txt");
      // Not even the branch's non-conflicting file was applied.
      expect((await treeOf("main"))["feature.txt"]).toBeUndefined();
    });

    it("refuses when the branch modified a file the target deleted", async () => {
      await submit("main", { "f.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "f.txt": "write" });
      await submit("main", { "f.txt": "delete" });
      await expectRefused("f.txt");
    });

    it("refuses when the branch deleted a file the target modified", async () => {
      await submit("main", { "f.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "f.txt": "delete" });
      await submit("main", { "f.txt": "write" });
      await expectRefused("f.txt");
    });

    it("refuses when both sides added the same path", async () => {
      await submit("main", { "base.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "new.txt": "write" });
      await submit("main", { "new.txt": "write" });
      await expectRefused("new.txt");
    });

    it("names every conflicting file", async () => {
      await submit("main", { "a.txt": "write", "b.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "a.txt": "write", "b.txt": "write" });
      await submit("main", { "a.txt": "write", "b.txt": "write" });

      await expect(merge("feature")).rejects.toThrow(/a\.txt[\s\S]*b\.txt/);
    });

    it("merges once the conflict is resolved on the branch", async () => {
      // Resolving means the branch takes the target's version as its base and
      // submits on top of it. In tree terms the target then no longer differs
      // from the merge base for that path. Model it by rebuilding the branch
      // from the current target head.
      await submit("main", { "both.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "both.txt": "write" });
      await submit("main", { "both.txt": "write" });
      await expect(merge("feature")).rejects.toMatchObject({
        code: "CONFLICT",
      });

      await caller.branch.deleteBranch({
        repoId,
        branchName: "feature",
        discardUnmerged: true,
      });
      await branchFrom("main", "feature");
      const resolved = await submit("feature", { "both.txt": "write" });

      await merge("feature");
      expect((await treeOf("main"))["both.txt"]).toBe(resolved);
    });
  });

  describe("preconditions", () => {
    it("refuses a branch with nothing to merge", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      await submit("main", { "b.txt": "write" });

      await expect(merge("feature")).rejects.toThrow("No changelists to merge");
    });

    it("refuses to merge into a branch that is not the parent", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "one");
      await branchFrom("main", "two");
      await submit("one", { "b.txt": "write" });

      await expect(merge("one", "two")).rejects.toThrow("parent branch");
    });

    it("refuses an archived target and an archived branch", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "b.txt": "write" });

      await testDb.client.branch.updateMany({
        where: { repoId, name: "feature" },
        data: { archivedAt: new Date() },
      });
      await expect(merge("feature")).rejects.toThrow("archived");

      await testDb.client.branch.updateMany({
        where: { repoId, name: "feature" },
        data: { archivedAt: null },
      });
      await testDb.client.branch.updateMany({
        where: { repoId, name: "main" },
        data: { archivedAt: new Date() },
      });
      await expect(merge("feature")).rejects.toThrow("archived");
    });
  });

  describe("atomicity and races", () => {
    it("leaves nothing behind when the merge fails partway", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "b.txt": "write" });
      const before = await snapshot();

      vi.mocked(restackChildren).mockRejectedValueOnce(
        new Error("restack failed"),
      );
      await expect(merge("feature")).rejects.toThrow("restack failed");

      expect(await snapshot()).toEqual(before);

      // And it can simply be tried again.
      await merge("feature");
      expect((await treeOf("main"))["b.txt"]).toBeDefined();
    });

    it("does not lose a submit that lands on the target during the merge", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      const f = await submit("feature", { "b.txt": "write" });

      const [, late] = await Promise.all([
        merge("feature"),
        submit("main", { "late.txt": "write" }),
      ]);

      const final = await treeOf("main");
      expect(final["b.txt"]).toBe(f);
      expect(final["late.txt"]).toBe(late);
    }, 60_000);

    it("merges two sibling branches at once without losing either", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "one");
      await branchFrom("main", "two");
      const o = await submit("one", { "one.txt": "write" });
      const t = await submit("two", { "two.txt": "write" });

      await Promise.all([merge("one"), merge("two")]);

      const final = await treeOf("main");
      expect(final["one.txt"]).toBe(o);
      expect(final["two.txt"]).toBe(t);
      expect(final["a.txt"]).toBeDefined();
    }, 60_000);

    it("merges a branch only once when asked twice at the same time", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      await submit("feature", { "b.txt": "write" });
      const before = await testDb.client.changelist.count({
        where: { repoId },
      });

      const outcomes = await Promise.allSettled([
        merge("feature"),
        merge("feature"),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
      expect(await testDb.client.changelist.count({ where: { repoId } })).toBe(
        before + 1,
      );
    }, 60_000);
  });

  describe("findMergeBase", () => {
    it("finds the fork point however far each side has moved", async () => {
      const fork = await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      const f1 = await submit("feature", { "f1.txt": "write" });
      await submit("main", { "m1.txt": "write" });
      await submit("main", { "m2.txt": "write" });
      const f2 = await submit("feature", { "f2.txt": "write" });
      await submit("main", { "m3.txt": "write" });

      const result = await findMergeBase(
        testDb.client,
        repoId,
        await head("main"),
        await head("feature"),
      );
      expect(result).toEqual({ base: fork, incomingNumbers: [f2, f1] });
    });

    it("reports nothing incoming when the branch has no changelists of its own", async () => {
      const fork = await submit("main", { "a.txt": "write" });
      await branchFrom("main", "feature");
      await submit("main", { "b.txt": "write" });

      const result = await findMergeBase(
        testDb.client,
        repoId,
        await head("main"),
        await head("feature"),
      );
      expect(result).toEqual({ base: fork, incomingNumbers: [] });
    });

    it("handles a branch stacked on another branch", async () => {
      await submit("main", { "a.txt": "write" });
      await branchFrom("main", "lower");
      const l = await submit("lower", { "l.txt": "write" });
      await branchFrom("lower", "upper");
      const u = await submit("upper", { "u.txt": "write" });
      await submit("lower", { "l2.txt": "write" });

      const result = await findMergeBase(
        testDb.client,
        repoId,
        await head("lower"),
        await head("upper"),
      );
      expect(result).toEqual({ base: l, incomingNumbers: [u] });
    });
  });

  describe("reading a file as of a changelist", () => {
    it("does not see a change from a branch the changelist is not on", async () => {
      // feature's changelist has a higher number than main's head at the time,
      // then main moves past it. "Newest change numbered at or below" would
      // hand main the feature branch's version.
      const m1 = await submit("main", { "f.txt": "write" });
      await branchFrom("main", "feature");
      const f = await submit("feature", { "f.txt": "write" });
      const m2 = await submit("main", { "other.txt": "write" });
      expect(f).toBeLessThan(m2);

      const onMain = await resolveFileSource(
        testDb.client,
        repoId,
        "f.txt",
        m2,
      );
      expect(onMain?.sourceChangelistNumber).toBe(m1);

      const onFeature = await resolveFileSource(
        testDb.client,
        repoId,
        "f.txt",
        f,
      );
      expect(onFeature?.sourceChangelistNumber).toBe(f);
    });

    it("resolves a merged file to the changelist that uploaded it, not to the merge", async () => {
      await submit("main", { "base.txt": "write" });
      await branchFrom("main", "feature");
      const f1 = await submit("feature", { "early.txt": "write" });
      const f2 = await submit("feature", { "late.txt": "write" });
      const merged = (await merge("feature")).mergeChangelist.number;

      // The merge changelist uploads nothing, so it has no version index, and
      // both files must come from the changelists that did upload them. The
      // old merge borrowed the branch head's index, which only had late.txt.
      const mergeCl = await testDb.client.changelist.findUniqueOrThrow({
        where: { repoId_number: { repoId, number: merged } },
      });
      expect(mergeCl.versionIndex).toBe("");

      const early = await resolveFileSource(
        testDb.client,
        repoId,
        "early.txt",
        merged,
      );
      const late = await resolveFileSource(
        testDb.client,
        repoId,
        "late.txt",
        merged,
      );
      expect(early?.sourceChangelistNumber).toBe(f1);
      expect(late?.sourceChangelistNumber).toBe(f2);
      expect(early?.versionIndex).toContain("early.txt");
      expect(late?.versionIndex).toContain("late.txt");
    });

    it("returns nothing for a deleted or never-added file", async () => {
      const c1 = await submit("main", { "f.txt": "write" });
      const c2 = await submit("main", { "f.txt": "delete" });

      expect(
        await resolveFileSource(testDb.client, repoId, "f.txt", c2),
      ).toBeNull();
      expect(
        await resolveFileSource(testDb.client, repoId, "nope.txt", c2),
      ).toBeNull();
      expect(
        (await resolveFileSource(testDb.client, repoId, "f.txt", c1))
          ?.sourceChangelistNumber,
      ).toBe(c1);
    });

    it("accepts a leading slash and backslashes", async () => {
      const c = await submit("main", { "dir/f.txt": "write" });
      for (const spelling of ["dir/f.txt", "/dir/f.txt", "dir\\f.txt"]) {
        expect(
          (await resolveFileSource(testDb.client, repoId, spelling, c))
            ?.sourceChangelistNumber,
          spelling,
        ).toBe(c);
      }
    });
  });

  describe("through a merge request", () => {
    async function openRequest() {
      await submit("main", { "shared.txt": "write", "main.txt": "write" });
      await branchFrom("main", "feature");
      const f = await submit("feature", { "shared.txt": "write" });
      const mr = await caller.mergeRequest.create({
        repoId,
        title: "Feature",
        description: "",
        sourceBranchName: "feature",
        targetBranchName: "main",
      });
      return { f, number: mr.number };
    }

    it("keeps the target's later changes, and marks the request merged", async () => {
      const { f, number } = await openRequest();
      const m = await submit("main", { "main.txt": "write" });

      await caller.mergeRequest.merge({ repoId, number });

      expect(await treeOf("main")).toEqual({ "shared.txt": f, "main.txt": m });
      const mr = await testDb.client.mergeRequest.findFirstOrThrow({
        where: { repoId, number },
      });
      expect(mr.status).toBe("MERGED");
    });

    it("refuses a conflicting request and leaves it open", async () => {
      const { number } = await openRequest();
      await submit("main", { "shared.txt": "write" });
      const before = await snapshot();

      await expect(
        caller.mergeRequest.merge({ repoId, number }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      expect(await snapshot()).toEqual(before);
      const mr = await testDb.client.mergeRequest.findFirstOrThrow({
        where: { repoId, number },
      });
      expect(mr.status).toBe("OPEN");
    });

    it("lists every changelist and file of the branch for review, even after the target moves", async () => {
      await submit("main", { "base.txt": "write" });
      await branchFrom("main", "feature");
      const f1 = await submit("feature", { "one.txt": "write" });
      await submit("main", { "main.txt": "write" });
      const f2 = await submit("feature", { "two.txt": "write" });
      const mr = await caller.mergeRequest.create({
        repoId,
        title: "Two changelists",
        description: "",
        sourceBranchName: "feature",
        targetBranchName: "main",
      });

      const changelists = await caller.mergeRequest.getChangelists({
        repoId,
        mrNumber: mr.number,
      });
      expect(changelists.map((cl) => cl.number)).toEqual([f2, f1]);

      const changed = await caller.mergeRequest.getChangedFiles({
        repoId,
        mrNumber: mr.number,
      });
      expect(changed.files.map((file) => file.path).sort()).toEqual([
        "one.txt",
        "two.txt",
      ]);
    });
  });
});
