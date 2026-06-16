// Tests for `branch` router: getBranch / listBranches / createBranch and
// the parent/type validity rules.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeUser, makeOrg, makeRepo, makeBranch } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

describe("branch router", () => {
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

  describe("getBranch / listBranches", () => {
    it("returns null for a missing branch (READ access only required)", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);

      const caller = await makeAppCaller({ asUser: owner });
      const res = await caller.branch.getBranch({
        repoId: repo.id,
        name: "nope",
      });
      expect(res).toBeNull();
    });

    it("listBranches returns the auto-created main + any user branches", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/x",
        type: "FEATURE",
        parentName: "main",
      });

      const caller = await makeAppCaller({ asUser: owner });
      const branches = await caller.branch.listBranches({
        repoId: repo.id,
        includeArchived: false,
      });
      const names = branches.map((b) => b.name).sort();
      expect(names).toEqual(["feature/x", "main"]);
    });

    it("listBranches hides archived branches by default", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const archived = await makeBranch(testDb.client, repo.id, owner.id, {
        name: "stale",
        type: "FEATURE",
        parentName: "main",
      });
      await testDb.client.branch.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });

      const caller = await makeAppCaller({ asUser: owner });
      const branches = await caller.branch.listBranches({
        repoId: repo.id,
        includeArchived: false,
      });
      expect(branches.map((b) => b.name)).toEqual(["main"]);

      const withArchived = await caller.branch.listBranches({
        repoId: repo.id,
        includeArchived: true,
      });
      expect(withArchived.map((b) => b.name).sort()).toEqual(["main", "stale"]);
    });

    it("non-member is rejected at the READ access gate", async () => {
      const owner = await makeUser(testDb.client);
      const eve = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { ownerId: owner.id });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: eve });
      await expect(
        caller.branch.listBranches({
          repoId: repo.id,
          includeArchived: false,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("createBranch", () => {
    it("creates a FEATURE branch off main", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: owner });

      const branch = await caller.branch.createBranch({
        repoId: repo.id,
        name: "feature/login",
        parentBranchName: "main",
      });

      expect(branch.name).toBe("feature/login");
      expect(branch.type).toBe("FEATURE");
      expect(branch.parentBranchName).toBe("main");
      expect(branch.createdBy?.id).toBe(owner.id);
    });

    it("inherits the parent's headNumber when headNumber is left at -1", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      // Bump main's headNumber to 7
      await testDb.client.branch.updateMany({
        where: { repoId: repo.id, name: "main" },
        data: { headNumber: 7 },
      });
      const caller = await makeAppCaller({ asUser: owner });

      const branch = await caller.branch.createBranch({
        repoId: repo.id,
        name: "feature/inherit",
        parentBranchName: "main",
      });
      expect(branch.headNumber).toBe(7);
    });

    it("rejects FEATURE-on-FEATURE parentage", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/a",
        type: "FEATURE",
        parentName: "main",
      });
      const caller = await makeAppCaller({ asUser: owner });

      await expect(
        caller.branch.createBranch({
          repoId: repo.id,
          name: "feature/b",
          parentBranchName: "feature/a",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("rejects RELEASE branches off non-MAINLINE parents", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/y",
        type: "FEATURE",
        parentName: "main",
      });
      const caller = await makeAppCaller({ asUser: owner });

      await expect(
        caller.branch.createBranch({
          repoId: repo.id,
          name: "release-1.0",
          type: "RELEASE",
          parentBranchName: "feature/y",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects non-MAINLINE branches created without a parent", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: owner });

      await expect(
        caller.branch.createBranch({
          repoId: repo.id,
          name: "loose",
          type: "FEATURE",
          parentBranchName: null,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects creation off an archived parent", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const parent = await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/dead",
        type: "FEATURE",
        parentName: "main",
      });
      await testDb.client.branch.update({
        where: { id: parent.id },
        data: { archivedAt: new Date() },
      });
      const caller = await makeAppCaller({ asUser: owner });

      await expect(
        caller.branch.createBranch({
          repoId: repo.id,
          name: "child",
          type: "FEATURE",
          parentBranchName: "feature/dead",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects unknown parent with NOT_FOUND", async () => {
      const owner = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: owner });

      await expect(
        caller.branch.createBranch({
          repoId: repo.id,
          name: "child",
          type: "FEATURE",
          parentBranchName: "ghost",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("READ-only members cannot create branches", async () => {
      const owner = await makeUser(testDb.client);
      const reader = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: owner.id,
        ownerRole: "ADMIN",
        defaultRepoAccess: "READ",
      });
      await testDb.client.orgUser.create({
        data: { orgId: org.id, userId: reader.id, role: "MEMBER" },
      });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: reader });

      await expect(
        caller.branch.createBranch({
          repoId: repo.id,
          name: "blocked",
          type: "FEATURE",
          parentBranchName: "main",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});
