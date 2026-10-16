/**
 * Submits from clients that send a base for every file they track
 * (basesComplete, set by the native submit of current addons) are held to it:
 * a write with no base on a path the branch already has is a conflict, not
 * left unchecked, so a stale copy cannot silently replace a teammate's change
 * (DL-12, the server half). Older clients, which may leave bases out, are not.
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

describe("strict bases", () => {
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

  const submit = (
    mods: { path: string; delete?: boolean; baseChangelist?: number | null }[],
    basesComplete?: boolean,
  ) =>
    caller.changelist.createChangelist({
      message: "m",
      repoId,
      versionIndex: "fake.lvi",
      branchName: "main",
      modifications: mods.map((m) => ({
        path: m.path,
        delete: m.delete ?? false,
        ...(m.baseChangelist !== undefined && {
          baseChangelist: m.baseChangelist,
        }),
      })),
      keepCheckedOut: false,
      workspaceId,
      ...(basesComplete !== undefined && { basesComplete }),
    });

  it("refuses a write with no base on a path the branch has", async () => {
    await submit([{ path: "notes.txt", baseChangelist: null }]);
    await expect(submit([{ path: "notes.txt" }], true)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("still accepts a write with no base on a new path", async () => {
    await expect(submit([{ path: "new.txt" }], true)).resolves.toBeDefined();
  });

  it("still accepts a write with the right base", async () => {
    const added = (await submit([{ path: "notes.txt", baseChangelist: null }]))
      .number;
    await expect(
      submit([{ path: "notes.txt", baseChangelist: added }], true),
    ).resolves.toBeDefined();
  });

  it("does not hold a client that may leave bases out to it", async () => {
    await submit([{ path: "notes.txt", baseChangelist: null }]);
    await expect(submit([{ path: "notes.txt" }])).resolves.toBeDefined();
  });

  it("does not need a base for a delete", async () => {
    await submit([{ path: "notes.txt", baseChangelist: null }]);
    await expect(
      submit([{ path: "notes.txt", delete: true }], true),
    ).resolves.toBeDefined();
  });
});
