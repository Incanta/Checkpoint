/**
 * Merge changelists record the head they merged (Changelist.mergedFromNumber),
 * and the merge base follows it as a second parent (findMergeBase in
 * src/app/src/server/branch-merge.ts), so work a merge already carried is
 * shared history and never compared again. Moved here from the data-loss red
 * team (DL-13).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../harness/db";
import {
  makeOrg,
  makeRepo,
  makeUser,
  makeWorkspace,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { getStateTreePaths } from "~/server/state-tree";
import { findMergeBase } from "~/server/branch-merge";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

describe("merge provenance", () => {
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

  /** Writes whole files to a branch; returns the changelist number. */
  async function write(branchName: string, ...paths: string[]) {
    return (
      await caller.changelist.createChangelist({
        message: `${branchName}: ${paths.join(", ")}`,
        repoId,
        versionIndex: "fake.lvi",
        branchName,
        modifications: paths.map((path) => ({ path, delete: false })),
        keepCheckedOut: false,
        workspaceId,
      })
    ).number;
  }

  const branchFrom = (parent: string, name: string) =>
    caller.branch.createBranch({
      repoId,
      name,
      type: "FEATURE",
      parentBranchName: parent,
    });

  const merge = (incoming: string, target: string) =>
    caller.branch.mergeBranch({
      repoId,
      incomingBranchName: incoming,
      targetBranchName: target,
    });

  async function head(branchName: string) {
    return (
      await testDb.client.branch.findFirstOrThrow({
        where: { repoId, name: branchName },
      })
    ).headNumber;
  }

  async function treeOf(branchName: string) {
    return Object.fromEntries(
      await getStateTreePaths(testDb.client, repoId, await head(branchName)),
    );
  }

  it("merges a stacked branch after its parent merged, when both changed the same file in turn", async () => {
    await write("main", "x.txt");
    await branchFrom("main", "lower");
    await write("lower", "x.txt");
    await branchFrom("lower", "upper");
    const u = await write("upper", "x.txt");
    await merge("lower", "main");

    await merge("upper", "main");

    expect((await treeOf("main"))["x.txt"]).toBe(u);
  });

  it("records the merged head on the merge changelist", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    const f = await write("feature", "b.txt");
    const merged = await merge("feature", "main");

    const row = await testDb.client.changelist.findUniqueOrThrow({
      where: {
        repoId_number: { repoId, number: merged.mergeChangelist.number },
      },
    });
    expect(row.mergedFromNumber).toBe(f);
  });

  it("merges a three-level stack bottom-up", async () => {
    await write("main", "x.txt");
    await branchFrom("main", "a");
    await write("a", "x.txt");
    await branchFrom("a", "b");
    await write("b", "x.txt");
    await branchFrom("b", "c");
    const c = await write("c", "x.txt");

    await merge("a", "main");
    await merge("b", "main");
    await merge("c", "main");

    expect((await treeOf("main"))["x.txt"]).toBe(c);
  });

  it("merges a three-level stack top-down", async () => {
    await write("main", "x.txt");
    await branchFrom("main", "a");
    await write("a", "x.txt");
    await branchFrom("a", "b");
    await write("b", "x.txt");
    await branchFrom("b", "c");
    const c = await write("c", "x.txt");

    await merge("c", "b");
    await merge("b", "a");
    await merge("a", "main");

    expect((await treeOf("main"))["x.txt"]).toBe(c);
  });

  it("still refuses a real conflict after a parent merged", async () => {
    // Shared history only covers what the merge carried: a change main made
    // on its own still conflicts with the stacked branch's change.
    await write("main", "x.txt");
    await branchFrom("main", "lower");
    await write("lower", "y.txt");
    await branchFrom("lower", "upper");
    await write("upper", "x.txt");
    await merge("lower", "main");
    await write("main", "x.txt");

    await expect(merge("upper", "main")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("finds the merge base across a history longer than one page of the ancestry walk", async () => {
    await write("main", "x.txt");
    await branchFrom("main", "feature");
    const forked = await head("main");
    for (let i = 0; i < 600; i++) {
      await write("main", `m${i % 7}.txt`);
    }
    await write("feature", "f.txt");

    const found = await findMergeBase(
      testDb.client,
      repoId,
      await head("main"),
      await head("feature"),
    );
    expect(found?.base).toBe(forked);
    expect(found?.incomingNumbers).toEqual([await head("feature")]);
  }, 300_000);
});
