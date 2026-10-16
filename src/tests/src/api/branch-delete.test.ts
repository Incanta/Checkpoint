/**
 * Deleting a branch keeps its work reachable. A delete of a branch with
 * changelists its parent never got is refused unless told to discard them,
 * and every deleted head (merged ones too) is kept in DeletedBranch so the
 * branch can be restored. Moved here from the data-loss red team (DL-15).
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

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

describe("deleting branches", () => {
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

  const write = async (branchName: string, ...paths: string[]) =>
    (
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

  const branchFrom = (parent: string, name: string) =>
    caller.branch.createBranch({
      repoId,
      name,
      type: "FEATURE",
      parentBranchName: parent,
    });

  const del = (branchName: string, discardUnmerged = false) =>
    caller.branch.deleteBranch({ repoId, branchName, discardUnmerged });

  const branchHead = async (name: string) =>
    (await testDb.client.branch.findFirst({ where: { repoId, name } }))
      ?.headNumber;

  it("refuses to delete a branch whose changelists were never merged, unless told to discard them", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    const work = await write("feature", "a week of work.txt");

    await expect(del("feature")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining(`#${work}`),
    });
    expect(await branchHead("feature")).toBe(work);

    await del("feature", true);
    expect(await branchHead("feature")).toBeUndefined();
    const kept = await caller.branch.listDeletedBranches({ repoId });
    expect(kept).toMatchObject([
      { name: "feature", headNumber: work, merged: false },
    ]);
  });

  it("deletes a branch with no changelists of its own without asking", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");

    await del("feature");
    expect(await branchHead("feature")).toBeUndefined();
  });

  it("does not count a changelist that only brought the parent in", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    await write("main", "b.txt");
    await caller.branch.updateFromParent({ repoId, branchName: "feature" });

    await del("feature");
    expect(await branchHead("feature")).toBeUndefined();
  });

  it("restores a deleted branch at its head, with its work", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    const work = await write("feature", "work.txt");
    await del("feature", true);
    const [kept] = await caller.branch.listDeletedBranches({ repoId });

    const restored = await caller.branch.restoreBranch({
      repoId,
      deletedBranchId: kept!.id,
    });

    expect(restored).toMatchObject({
      name: "feature",
      headNumber: work,
      parentBranchName: "main",
      type: "FEATURE",
    });
    expect(await caller.branch.listDeletedBranches({ repoId })).toEqual([]);
    // It merges like any branch.
    await caller.branch.mergeBranch({
      repoId,
      incomingBranchName: "feature",
      targetBranchName: "main",
    });
  });

  it("restores under another name when the old one is taken", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    await write("feature", "work.txt");
    await del("feature", true);
    await branchFrom("main", "feature");
    const [kept] = await caller.branch.listDeletedBranches({ repoId });

    await expect(
      caller.branch.restoreBranch({ repoId, deletedBranchId: kept!.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const restored = await caller.branch.restoreBranch({
      repoId,
      deletedBranchId: kept!.id,
      name: "feature-restored",
    });
    expect(restored.name).toBe("feature-restored");
  });

  it("asks for another parent when the old one is gone", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "lower");
    await branchFrom("lower", "upper");
    await write("upper", "u.txt");
    await del("upper", true);
    await del("lower");
    const upper = (await caller.branch.listDeletedBranches({ repoId })).find(
      (d) => d.name === "upper",
    )!;

    await expect(
      caller.branch.restoreBranch({ repoId, deletedBranchId: upper.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const restored = await caller.branch.restoreBranch({
      repoId,
      deletedBranchId: upper.id,
      parentBranchName: "main",
    });
    expect(restored.parentBranchName).toBe("main");
  });

  it("keeps the head of a branch its merge deleted", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    const work = await write("feature", "work.txt");
    await caller.branch.mergeBranch({
      repoId,
      incomingBranchName: "feature",
      targetBranchName: "main",
    });

    expect(await caller.branch.listDeletedBranches({ repoId })).toMatchObject([
      { name: "feature", headNumber: work, merged: true },
    ]);
  });
});
