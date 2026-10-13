// Tests for `changelist.createChangelist`, the one place a submit becomes
// history.
//
// It used to read the branch head, work out the next changelist number, and
// then write the changelist, the new head, and the file changes as separate
// statements. Two submits arriving together could both read the same head: the
// second one's head update then overwrote the first's, leaving a changelist
// that exists but that no branch reaches. A failure partway through left a
// changelist with no file changes, or a head pointing past the claims that
// should have been settled with it. And nothing compared what a submitter's
// files were based on with what the branch held, so a submit from a stale
// workspace silently replaced whatever had landed since.
//
// The contract now: a submit is all or nothing, the head only ever advances
// from the changelist the submit was built on, and a file whose base no longer
// matches the branch is a conflict.

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
  makeBranch,
  makeWorkspace,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { getStateTreePaths } from "~/server/state-tree";
import { settleClaimsForSubmit } from "~/server/claims/claims";

// The real implementation, wrapped so one test can make it fail inside the
// transaction.
vi.mock("~/server/claims/claims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/claims/claims")>();
  return {
    ...actual,
    settleClaimsForSubmit: vi.fn(actual.settleClaimsForSubmit),
  };
});

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

interface Mod {
  path: string;
  delete?: boolean;
  baseChangelist?: number | null;
}

describe("changelist.createChangelist", () => {
  let testDb: TestDb;
  let caller: Caller;
  let repoId: string;
  let orgId: string;
  let ownerId: string;
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
    orgId = org.id;
    ownerId = owner.id;
    workspaceId = workspace.id;
  });

  function submit(mods: Mod[], branchName = "main", ws = workspaceId) {
    return caller.changelist.createChangelist({
      message: `submit ${mods.map((m) => m.path).join(",")}`,
      repoId,
      versionIndex: "",
      branchName,
      modifications: mods.map((m) => ({
        path: m.path,
        delete: m.delete ?? false,
        ...(m.baseChangelist !== undefined && {
          baseChangelist: m.baseChangelist,
        }),
      })),
      keepCheckedOut: false,
      workspaceId: ws,
    });
  }

  async function head(branchName = "main"): Promise<number> {
    const branch = await testDb.client.branch.findFirstOrThrow({
      where: { repoId, name: branchName },
    });
    return branch.headNumber;
  }

  /** Changelist numbers from a branch head back to the root, newest first. */
  async function lineage(branchName = "main"): Promise<number[]> {
    const numbers: number[] = [];
    let current: number | null = await head(branchName);
    while (current !== null) {
      numbers.push(current);
      const cl: { parentNumber: number | null } =
        await testDb.client.changelist.findUniqueOrThrow({
          where: { repoId_number: { repoId, number: current } },
          select: { parentNumber: true },
        });
      current = cl.parentNumber;
    }
    return numbers;
  }

  async function treeAt(number: number): Promise<Map<string, number>> {
    return new Map(await getStateTreePaths(testDb.client, repoId, number));
  }

  async function counts() {
    return {
      changelists: await testDb.client.changelist.count({ where: { repoId } }),
      fileChanges: await testDb.client.fileChange.count({ where: { repoId } }),
      files: await testDb.client.file.count({ where: { repoId } }),
    };
  }

  describe("a single submit", () => {
    it("creates the changelist on top of the head and moves the head to it", async () => {
      const result = await submit([{ path: "a.txt" }, { path: "dir/b.txt" }]);

      expect(result.number).toBe(1);
      expect(await head()).toBe(1);
      expect(await lineage()).toEqual([1, 0]);
      expect([...(await treeAt(1)).entries()].sort()).toEqual([
        ["a.txt", 1],
        ["dir/b.txt", 1],
      ]);
      expect(
        await testDb.client.fileChange.count({
          where: { repoId, changelistNumber: 1 },
        }),
      ).toBe(2);
    });

    it("chains submits one after another", async () => {
      await submit([{ path: "a.txt" }]);
      await submit([{ path: "b.txt" }]);
      await submit([{ path: "a.txt", delete: true }]);

      expect(await lineage()).toEqual([3, 2, 1, 0]);
      expect([...(await treeAt(3)).entries()]).toEqual([["b.txt", 2]]);
    });
  });

  describe("submits that arrive together", () => {
    it("keeps every changelist reachable when many land on one branch at once", async () => {
      const n = 8;
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => submit([{ path: `f${i}.txt` }])),
      );

      const numbers = results.map((r) => r.number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: n }, (_, i) => i + 1));

      // One unbroken line from the head to the root: no changelist was
      // overwritten out of the branch.
      const line = await lineage();
      expect(line).toEqual(Array.from({ length: n + 1 }, (_, i) => n - i));

      // And the head's tree has every file, each at the changelist that
      // submitted it.
      const tree = await treeAt(await head());
      expect(tree.size).toBe(n);
      for (let i = 0; i < n; i++) {
        expect(tree.get(`f${i}.txt`), `f${i}.txt`).toBe(results[i]!.number);
      }

      const c = await counts();
      expect(c.changelists).toBe(n + 1);
      expect(c.fileChanges).toBe(n);
      expect(c.files).toBe(n);
    }, 120_000);

    it("keeps both lines intact when two branches are submitted to at once", async () => {
      await submit([{ path: "base.txt" }]);
      const feature = await makeBranch(testDb.client, repoId, ownerId, {
        name: "feature",
      });
      await testDb.client.branch.update({
        where: { id: feature.id },
        data: { headNumber: 1 },
      });

      const n = 4;
      const results = await Promise.all([
        ...Array.from({ length: n }, (_, i) =>
          submit([{ path: `main${i}.txt` }], "main"),
        ),
        ...Array.from({ length: n }, (_, i) =>
          submit([{ path: `feature${i}.txt` }], "feature"),
        ),
      ]);

      const numbers = results.map((r) => r.number).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(2 * n);

      const mainLine = await lineage("main");
      const featureLine = await lineage("feature");
      // n submits each, plus the shared changelists 1 and 0.
      expect(mainLine.length).toBe(n + 2);
      expect(featureLine.length).toBe(n + 2);
      // Every changelist belongs to exactly one line (after the fork point).
      const afterFork = (line: number[]) => line.filter((x) => x > 1);
      expect(
        new Set([...afterFork(mainLine), ...afterFork(featureLine)]).size,
      ).toBe(2 * n);

      const mainTree = await treeAt(await head("main"));
      const featureTree = await treeAt(await head("feature"));
      for (let i = 0; i < n; i++) {
        expect(mainTree.has(`main${i}.txt`)).toBe(true);
        expect(mainTree.has(`feature${i}.txt`)).toBe(false);
        expect(featureTree.has(`feature${i}.txt`)).toBe(true);
        expect(featureTree.has(`main${i}.txt`)).toBe(false);
      }
    }, 120_000);

    it("lets exactly one of two edits to the same version of a file through", async () => {
      await submit([{ path: "shared.txt" }]);

      const outcomes = await Promise.allSettled([
        submit([{ path: "shared.txt", baseChangelist: 1 }]),
        submit([{ path: "shared.txt", baseChangelist: 1 }]),
      ]);

      const won = outcomes.filter((o) => o.status === "fulfilled");
      const lost = outcomes.filter((o) => o.status === "rejected");
      expect(won.length).toBe(1);
      expect(lost.length).toBe(1);
      expect((lost[0] as PromiseRejectedResult).reason.code).toBe("CONFLICT");

      expect(await lineage()).toEqual([2, 1, 0]);
      expect((await counts()).changelists).toBe(3);
    }, 60_000);
  });

  describe("what a file was based on", () => {
    beforeEach(async () => {
      // CL 1 adds two files; CL 2 changes one of them.
      await submit([{ path: "stale.txt" }, { path: "steady.txt" }]);
      await submit([{ path: "stale.txt" }]);
    });

    async function expectConflict(mods: Mod[], mention: string) {
      const before = await counts();
      const headBefore = await head();

      await expect(submit(mods)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(submit(mods)).rejects.toThrow(mention);

      expect(await counts()).toEqual(before);
      expect(await head()).toBe(headBefore);
    }

    it("accepts an edit based on the version at the head", async () => {
      const result = await submit([
        { path: "stale.txt", baseChangelist: 2 },
        { path: "steady.txt", baseChangelist: 1 },
      ]);
      expect(result.number).toBe(3);
    });

    it("refuses an edit based on a version the branch has moved past", async () => {
      await expectConflict(
        [{ path: "stale.txt", baseChangelist: 1 }],
        "stale.txt",
      );
    });

    it("refuses the whole submit when one file of several is stale", async () => {
      await expectConflict(
        [
          { path: "steady.txt", baseChangelist: 1 },
          { path: "stale.txt", baseChangelist: 1 },
          { path: "brand-new.txt", baseChangelist: null },
        ],
        "stale.txt",
      );
      expect((await treeAt(await head())).has("brand-new.txt")).toBe(false);
    });

    it("accepts a new file the branch does not have", async () => {
      const result = await submit([{ path: "new.txt", baseChangelist: null }]);
      expect(result.number).toBe(3);
    });

    it("refuses a 'new' file that someone else already added", async () => {
      await expectConflict(
        [{ path: "steady.txt", baseChangelist: null }],
        "steady.txt",
      );
    });

    it("refuses an edit to a file that was deleted on the branch", async () => {
      await submit([{ path: "steady.txt", delete: true }]);
      await expectConflict(
        [{ path: "steady.txt", baseChangelist: 1 }],
        "steady.txt",
      );
    });

    it("refuses a delete of a version the branch has moved past", async () => {
      await expectConflict(
        [{ path: "stale.txt", delete: true, baseChangelist: 1 }],
        "stale.txt",
      );
    });

    it("accepts a delete of the version at the head", async () => {
      await submit([{ path: "stale.txt", delete: true, baseChangelist: 2 }]);
      expect((await treeAt(await head())).has("stale.txt")).toBe(false);
    });

    it("accepts a delete of a file that is already gone", async () => {
      await submit([{ path: "steady.txt", delete: true }]);
      const result = await submit([
        { path: "steady.txt", delete: true, baseChangelist: 1 },
      ]);
      expect(result.number).toBe(4);
    });

    it("does not check a file whose base was not given", async () => {
      // Callers that predate the check, and files submitted across branches,
      // send no base. They behave as before.
      const result = await submit([{ path: "stale.txt" }]);
      expect(result.number).toBe(3);
    });

    it("compares against the branch being submitted to, not the repo's newest changelist", async () => {
      const feature = await makeBranch(testDb.client, repoId, ownerId, {
        name: "feature",
      });
      await testDb.client.branch.update({
        where: { id: feature.id },
        data: { headNumber: 1 },
      });

      // On "feature", stale.txt is still the version from changelist 1.
      const result = await caller.changelist.createChangelist({
        message: "on feature",
        repoId,
        versionIndex: "",
        branchName: "feature",
        modifications: [
          { path: "stale.txt", delete: false, baseChangelist: 1 },
        ],
        keepCheckedOut: false,
        workspaceId,
      });
      expect(result.number).toBe(3);
      expect(await head("feature")).toBe(3);
      expect(await head("main")).toBe(2);
    });

    it("normalizes backslashes before comparing", async () => {
      await submit([{ path: "dir/nested.txt", baseChangelist: null }]);
      await expectConflict(
        [{ path: "dir\\nested.txt", baseChangelist: 1 }],
        "dir/nested.txt",
      );
    });
  });

  describe("a submit that fails partway", () => {
    it("leaves no changelist, no file changes, and the head where it was", async () => {
      await submit([{ path: "kept.txt" }]);
      const before = await counts();

      vi.mocked(settleClaimsForSubmit).mockRejectedValueOnce(
        new Error("claims could not be settled"),
      );
      await expect(submit([{ path: "lost.txt" }])).rejects.toThrow(
        "claims could not be settled",
      );

      expect(await counts()).toEqual(before);
      expect(await head()).toBe(1);
      expect(await lineage()).toEqual([1, 0]);
      expect(
        await testDb.client.changelist.findUnique({
          where: { repoId_number: { repoId, number: 2 } },
        }),
      ).toBeNull();

      // And the number it would have used is free for the next submit.
      const next = await submit([{ path: "lost.txt" }]);
      expect(next.number).toBe(2);
      expect(await lineage()).toEqual([2, 1, 0]);
    });

    it("refuses an archived branch without creating anything", async () => {
      await testDb.client.branch.updateMany({
        where: { repoId, name: "main" },
        data: { archivedAt: new Date() },
      });
      const before = await counts();

      await expect(submit([{ path: "a.txt" }])).rejects.toThrow("archived");
      expect(await counts()).toEqual(before);
    });

    it("refuses a workspace the caller does not own", async () => {
      const stranger = await makeUser(testDb.client);
      const theirs = await makeWorkspace(
        testDb.client,
        repoId,
        orgId,
        stranger.id,
      );
      const before = await counts();

      await expect(
        submit([{ path: "a.txt" }], "main", theirs.id),
      ).rejects.toThrow();
      expect(await counts()).toEqual(before);
    });
  });
});
