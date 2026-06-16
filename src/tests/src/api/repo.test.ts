// Tests for `repo` router: createRepo / getRepo / getMyRepoAccess /
// updateRepo / deleteRepo / list. Exercises the org-membership gate, the
// SeaweedFS rollback path on createRepo, and the access-filtering on list.

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
import { makeUser, makeOrg, makeRepo } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import * as storageService from "~/server/storage-service";

describe("repo router", () => {
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

  describe("createRepo", () => {
    it("creates a repo, the initial changelist #0, and the main branch", async () => {
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      const caller = await makeAppCaller({ asUser: admin });

      const repo = await caller.repo.createRepo({
        name: "ledger",
        orgId: org.id,
      });

      expect(repo.name).toBe("ledger");
      expect(repo.orgId).toBe(org.id);

      const initial = await testDb.client.changelist.findFirstOrThrow({
        where: { repoId: repo.id, number: 0 },
      });
      expect(initial.message).toBe("Repo Creation");

      const main = await testDb.client.branch.findFirstOrThrow({
        where: { repoId: repo.id, name: "main" },
      });
      expect(main.isDefault).toBe(true);
      expect(main.type).toBe("MAINLINE");
    });

    it("rolls back the repo + branch + changelist if storage provisioning fails", async () => {
      vi.mocked(storageService.createRepoDirectory).mockRejectedValueOnce(
        new Error("filer offline"),
      );
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      const caller = await makeAppCaller({ asUser: admin });

      await expect(
        caller.repo.createRepo({ name: "doomed", orgId: org.id }),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

      // Nothing left behind in the DB.
      const repos = await testDb.client.repo.findMany({
        where: { name: "doomed" },
      });
      expect(repos).toHaveLength(0);
      const branches = await testDb.client.branch.findMany({
        where: { name: "main", repo: { name: "doomed" } },
      });
      expect(branches).toHaveLength(0);
    });

    it("MEMBER without defaultCanCreateRepos is rejected", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
        defaultCanCreateRepos: false,
      });
      const caller = await makeAppCaller({ asUser: member });

      await expect(
        caller.repo.createRepo({ name: "x", orgId: org.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("MEMBER with defaultCanCreateRepos is allowed", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
        defaultCanCreateRepos: true,
      });
      const caller = await makeAppCaller({ asUser: member });

      const repo = await caller.repo.createRepo({
        name: "open",
        orgId: org.id,
      });
      expect(repo.name).toBe("open");
    });

    it("non-member is rejected", async () => {
      const eve = await makeUser(testDb.client);
      const someoneElse = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { ownerId: someoneElse.id });
      const caller = await makeAppCaller({ asUser: eve });

      await expect(
        caller.repo.createRepo({ name: "x", orgId: org.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("getMyRepoAccess", () => {
    it("org admins get both isAdmin and canWrite even under a default-READ org", async () => {
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
        // READ is the tightest org-wide default; admins should still write.
        defaultRepoAccess: "READ",
      });
      const repo = await makeRepo(testDb.client, org.id, admin.id);
      const caller = await makeAppCaller({ asUser: admin });

      const access = await caller.repo.getMyRepoAccess({ repoId: repo.id });
      expect(access).toEqual({ isMember: true, canWrite: true, isAdmin: true });
    });

    it("returns canWrite for MEMBER when defaultRepoAccess is WRITE", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
        defaultRepoAccess: "WRITE",
      });
      const repo = await makeRepo(testDb.client, org.id, member.id);
      const caller = await makeAppCaller({ asUser: member });

      const access = await caller.repo.getMyRepoAccess({ repoId: repo.id });
      expect(access).toEqual({
        isMember: true,
        canWrite: true,
        isAdmin: false,
      });
    });

    it("returns no write for MEMBER when defaultRepoAccess is READ", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
        defaultRepoAccess: "READ",
      });
      const repo = await makeRepo(testDb.client, org.id, member.id);
      const caller = await makeAppCaller({ asUser: member });

      const access = await caller.repo.getMyRepoAccess({ repoId: repo.id });
      expect(access).toEqual({
        isMember: true,
        canWrite: false,
        isAdmin: false,
      });
    });

    it("returns all-false for non-members", async () => {
      const owner = await makeUser(testDb.client);
      const stranger = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { ownerId: owner.id });
      const repo = await makeRepo(testDb.client, org.id, owner.id);
      const caller = await makeAppCaller({ asUser: stranger });

      const access = await caller.repo.getMyRepoAccess({ repoId: repo.id });
      expect(access).toEqual({
        isMember: false,
        canWrite: false,
        isAdmin: false,
      });
    });

    it("throws NOT_FOUND for unknown repos", async () => {
      const u = await makeUser(testDb.client);
      const caller = await makeAppCaller({ asUser: u });
      await expect(
        caller.repo.getMyRepoAccess({ repoId: "nonexistent" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("WRITE repoRole upgrades canWrite for an otherwise-READ org", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
        defaultRepoAccess: "READ",
      });
      const repo = await makeRepo(testDb.client, org.id, member.id);
      await testDb.client.repoRole.create({
        data: { repoId: repo.id, userId: member.id, access: "WRITE" },
      });
      const caller = await makeAppCaller({ asUser: member });
      const access = await caller.repo.getMyRepoAccess({ repoId: repo.id });
      expect(access.canWrite).toBe(true);
    });
  });

  describe("updateRepo", () => {
    it("ADMIN can rename a repo", async () => {
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, admin.id, {
        name: "old-name",
      });
      const caller = await makeAppCaller({ asUser: admin });

      const updated = await caller.repo.updateRepo({
        id: repo.id,
        name: "new-name",
      });
      expect(updated.name).toBe("new-name");
    });

    it("non-admin cannot update a repo", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
        defaultRepoAccess: "READ",
      });
      const repo = await makeRepo(testDb.client, org.id, member.id);
      const caller = await makeAppCaller({ asUser: member });
      await expect(
        caller.repo.updateRepo({ id: repo.id, name: "no" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("deleteRepo", () => {
    it("ADMIN can soft-delete a repo and trigger storage cleanup", async () => {
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      const repo = await makeRepo(testDb.client, org.id, admin.id);
      const caller = await makeAppCaller({ asUser: admin });

      await caller.repo.deleteRepo({ id: repo.id });

      const row = await testDb.client.repo.findUniqueOrThrow({
        where: { id: repo.id },
      });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(admin.id);
      // Name rewritten so the original is reusable.
      expect(row.name.startsWith(repo.name + "-deleted-")).toBe(true);

      expect(vi.mocked(storageService.deleteRepoDirectory)).toHaveBeenCalledWith(
        org.id,
        repo.id,
      );
    });

    it("non-admin cannot delete", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
        defaultRepoAccess: "WRITE",
      });
      const repo = await makeRepo(testDb.client, org.id, member.id);
      const caller = await makeAppCaller({ asUser: member });
      await expect(
        caller.repo.deleteRepo({ id: repo.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("list", () => {
    it("returns all repos for org admins", async () => {
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      await makeRepo(testDb.client, org.id, admin.id, { name: "a" });
      await makeRepo(testDb.client, org.id, admin.id, { name: "b" });
      const caller = await makeAppCaller({ asUser: admin });

      const repos = await caller.repo.list({ orgId: org.id });
      expect(repos.map((r) => r.name).sort()).toEqual(["a", "b"]);
    });

    it("excludes soft-deleted repos", async () => {
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      const live = await makeRepo(testDb.client, org.id, admin.id, {
        name: "live",
      });
      const ghost = await makeRepo(testDb.client, org.id, admin.id, {
        name: "ghost",
      });
      await testDb.client.repo.update({
        where: { id: ghost.id },
        data: { deletedAt: new Date() },
      });
      const caller = await makeAppCaller({ asUser: admin });

      const repos = await caller.repo.list({ orgId: org.id });
      expect(repos.map((r) => r.id)).toEqual([live.id]);
    });

    it("non-member is rejected with FORBIDDEN", async () => {
      const owner = await makeUser(testDb.client);
      const stranger = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { ownerId: owner.id });
      const caller = await makeAppCaller({ asUser: stranger });
      await expect(caller.repo.list({ orgId: org.id })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("MEMBER sees only public repos when they hold no per-repo role", async () => {
      const admin = await makeUser(testDb.client);
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
        defaultRepoAccess: "NONE",
      });
      await testDb.client.orgUser.create({
        data: { orgId: org.id, userId: member.id, role: "MEMBER" },
      });
      await makeRepo(testDb.client, org.id, admin.id, {
        name: "public-repo",
        public: true,
      });
      await makeRepo(testDb.client, org.id, admin.id, {
        name: "private-repo",
        public: false,
      });

      const caller = await makeAppCaller({ asUser: member });
      const repos = await caller.repo.list({ orgId: org.id });
      expect(repos.map((r) => r.name)).toEqual(["public-repo"]);
    });

    it("MEMBER sees a private repo when granted an explicit repoRole", async () => {
      const admin = await makeUser(testDb.client);
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
        defaultRepoAccess: "NONE",
      });
      await testDb.client.orgUser.create({
        data: { orgId: org.id, userId: member.id, role: "MEMBER" },
      });
      const granted = await makeRepo(testDb.client, org.id, admin.id, {
        name: "granted-repo",
      });
      await makeRepo(testDb.client, org.id, admin.id, {
        name: "ungranted-repo",
      });
      await testDb.client.repoRole.create({
        data: { repoId: granted.id, userId: member.id, access: "READ" },
      });

      const caller = await makeAppCaller({ asUser: member });
      const repos = await caller.repo.list({ orgId: org.id });
      expect(repos.map((r) => r.name)).toEqual(["granted-repo"]);
    });

    it("MEMBER does NOT see a repo where their repoRole is explicitly NONE", async () => {
      const admin = await makeUser(testDb.client);
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
        defaultRepoAccess: "NONE",
      });
      await testDb.client.orgUser.create({
        data: { orgId: org.id, userId: member.id, role: "MEMBER" },
      });
      const denied = await makeRepo(testDb.client, org.id, admin.id, {
        name: "denied-repo",
      });
      await testDb.client.repoRole.create({
        data: { repoId: denied.id, userId: member.id, access: "NONE" },
      });

      const caller = await makeAppCaller({ asUser: member });
      const repos = await caller.repo.list({ orgId: org.id });
      expect(repos).toEqual([]);
    });
  });
});
