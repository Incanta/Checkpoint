/**
 * A workspace overlays one chain of feature branches on its domain root,
 * ancestor first. It syncs the last branch's head, which holds the branches
 * beneath it; two siblings have no head that holds both, so a pull would take
 * one's changes out and a submit would have no head to check its bases
 * against. workspace.setBranchState refuses anything else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../harness/db";
import {
  makeBranch,
  makeOrg,
  makeRepo,
  makeUser,
  makeWorkspace,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

describe("one active branch chain per workspace", () => {
  let testDb: TestDb;
  let caller: Caller;
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
    // main <- feature-x <- feature-x2, and main <- feature-y
    for (const [name, parentName] of [
      ["feature-x", "main"],
      ["feature-x2", "feature-x"],
      ["feature-y", "main"],
    ] as const) {
      await makeBranch(testDb.client, repo.id, owner.id, { name, parentName });
    }
    const workspace = await makeWorkspace(
      testDb.client,
      repo.id,
      org.id,
      owner.id,
    );
    caller = await makeAppCaller({ asUser: owner });
    workspaceId = workspace.id;
  });

  const setActive = (activeBranches: string[]) =>
    caller.workspace.setBranchState({
      workspaceId,
      domainBranchName: "main",
      activeBranches,
    });

  it("accepts no overlay, one branch, and a stacked chain", async () => {
    await expect(setActive([])).resolves.toEqual({ ok: true });
    await expect(setActive(["feature-y"])).resolves.toEqual({ ok: true });
    await expect(setActive(["feature-x", "feature-x2"])).resolves.toEqual({
      ok: true,
    });
  });

  it("refuses two sibling branches", async () => {
    await expect(setActive(["feature-x", "feature-y"])).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("one chain"),
    });
  });

  it("refuses a sibling beside a stacked chain", async () => {
    await expect(
      setActive(["feature-x", "feature-x2", "feature-y"]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a chain listed deepest first", async () => {
    await expect(setActive(["feature-x2", "feature-x"])).rejects.toMatchObject(
      { code: "BAD_REQUEST", message: expect.stringContaining("before it") },
    );
  });

  it("refuses a branch listed twice", async () => {
    await expect(setActive(["feature-x", "feature-x"])).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("still refuses a stacked branch without its parent", async () => {
    await expect(setActive(["feature-x2"])).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("must be active too"),
    });
  });
});
