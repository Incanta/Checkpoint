// Tests for `changelist` router: getChangelist, getChangelistsWithNumbers,
// and getChangelists' parent-chain walking. The CLI uses getChangelists for
// `chk log`, so this is one of the more critical surfaces.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeUser, makeOrg, makeRepo } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

async function seedLinearHistory(
  testDb: TestDb,
  owner: { id: string },
  repoId: string,
  count: number,
): Promise<void> {
  // makeRepo already created changelist 0 + main branch.
  let parent = 0;
  for (let n = 1; n <= count; n++) {
    await testDb.client.changelist.create({
      data: {
        number: n,
        message: `Commit ${n}`,
        versionIndex: "",
        repoId,
        userId: owner.id,
        parentNumber: parent,
      },
    });
    parent = n;
  }
  await testDb.client.branch.updateMany({
    where: { repoId, name: "main" },
    data: { headNumber: count },
  });
}

describe("changelist router", () => {
  let testDb: TestDb;

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
  });

  describe("getChangelist", () => {
    it("returns a single changelist by repo+number", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await seedLinearHistory(testDb, owner, repo.id, 2);

      const caller = await makeAppCaller({ asUser: owner });
      const cl = await caller.changelist.getChangelist({
        repoId: repo.id,
        changelistNumber: 1,
      });
      expect(cl?.number).toBe(1);
      expect(cl?.message).toBe("Commit 1");
    });

    it("returns null for missing changelist numbers", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: owner });

      const cl = await caller.changelist.getChangelist({
        repoId: repo.id,
        changelistNumber: 99,
      });
      expect(cl).toBeNull();
    });
  });

  describe("getChangelistsWithNumbers", () => {
    it("returns the requested numbers, no order guarantee", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await seedLinearHistory(testDb, owner, repo.id, 5);
      const caller = await makeAppCaller({ asUser: owner });

      const res = await caller.changelist.getChangelistsWithNumbers({
        repoId: repo.id,
        numbers: [1, 3, 5],
      });
      expect(res.map((c) => c.number).sort()).toEqual([1, 3, 5]);
    });

    it("silently drops numbers that don't exist", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await seedLinearHistory(testDb, owner, repo.id, 2);
      const caller = await makeAppCaller({ asUser: owner });

      const res = await caller.changelist.getChangelistsWithNumbers({
        repoId: repo.id,
        numbers: [1, 99, 100],
      });
      expect(res.map((c) => c.number)).toEqual([1]);
    });
  });

  describe("getChangelists (the log workhorse)", () => {
    it("returns latest N starting at the branch head when start is null", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await seedLinearHistory(testDb, owner, repo.id, 5);
      const caller = await makeAppCaller({ asUser: owner });

      const res = await caller.changelist.getChangelists({
        repoId: repo.id,
        branchName: "main",
        start: { number: null, timestamp: null },
        count: 100,
      });
      // 6 total: #0 (repo creation) + #1..#5. Returned newest-first.
      expect(res.map((c) => c.number)).toEqual([5, 4, 3, 2, 1, 0]);
    });

    it("respects `count` as an upper bound", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await seedLinearHistory(testDb, owner, repo.id, 10);
      const caller = await makeAppCaller({ asUser: owner });

      const res = await caller.changelist.getChangelists({
        repoId: repo.id,
        branchName: "main",
        start: { number: null, timestamp: null },
        count: 3,
      });
      expect(res.map((c) => c.number)).toEqual([10, 9, 8]);
    });

    it("starts at a specific number when `start.number` is set", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await seedLinearHistory(testDb, owner, repo.id, 8);
      const caller = await makeAppCaller({ asUser: owner });

      const res = await caller.changelist.getChangelists({
        repoId: repo.id,
        branchName: "main",
        start: { number: 5, timestamp: null },
        count: 3,
      });
      expect(res.map((c) => c.number)).toEqual([5, 4, 3]);
    });

    it("throws NOT_FOUND when the branch does not exist", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: owner });

      await expect(
        caller.changelist.getChangelists({
          repoId: repo.id,
          branchName: "ghost",
          start: { number: null, timestamp: null },
          count: 10,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects unauthorized callers at the READ access gate", async () => {
      const owner = await makeUser(testDb.client);
      const eve = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { ownerId: owner.id });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: eve });

      await expect(
        caller.changelist.getChangelists({
          repoId: repo.id,
          branchName: "main",
          start: { number: null, timestamp: null },
          count: 10,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects count outside the [1, 100] range", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: owner });

      await expect(
        caller.changelist.getChangelists({
          repoId: repo.id,
          branchName: "main",
          start: { number: null, timestamp: null },
          count: 0,
        }),
      ).rejects.toThrow();

      await expect(
        caller.changelist.getChangelists({
          repoId: repo.id,
          branchName: "main",
          start: { number: null, timestamp: null },
          count: 101,
        }),
      ).rejects.toThrow();
    });
  });
});
