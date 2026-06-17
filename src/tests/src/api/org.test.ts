// Tests for `org` router: createOrg / myOrgs / getOrg / updateOrg / deleteOrg
// / addUserToOrg. Exercises the protectedProcedure auth gate and the org-
// admin permission checks.

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
import { makeUser, makeOrg } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import * as storageService from "~/server/storage-service";

describe("org router", () => {
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

  describe("createOrg", () => {
    it("creates the org and attaches the caller as ADMIN", async () => {
      const alice = await makeUser(testDb.client);
      const caller = await makeAppCaller({ asUser: alice });

      const org = await caller.org.createOrg({ name: "Acme" });

      expect(org.name).toBe("Acme");
      const orgUser = await testDb.client.orgUser.findFirstOrThrow({
        where: { orgId: org.id, userId: alice.id },
      });
      expect(orgUser.role).toBe("ADMIN");
    });

    it("invokes createOrgDirectory in storage", async () => {
      const alice = await makeUser(testDb.client);
      const caller = await makeAppCaller({ asUser: alice });
      const created = await caller.org.createOrg({ name: "Storage Test" });

      expect(vi.mocked(storageService.createOrgDirectory)).toHaveBeenCalledWith(
        created.id,
      );
    });

    it("does not fail the procedure when storage provisioning errors", async () => {
      vi.mocked(storageService.createOrgDirectory).mockRejectedValueOnce(
        new Error("storage offline"),
      );
      const alice = await makeUser(testDb.client);
      const caller = await makeAppCaller({ asUser: alice });

      // Should still return the org — the error is logged and swallowed.
      const org = await caller.org.createOrg({ name: "Resilient" });
      expect(org.name).toBe("Resilient");
    });

    it("requires authentication", async () => {
      const caller = await makeAppCaller();
      await expect(caller.org.createOrg({ name: "x" })).rejects.toThrow(
        /UNAUTHORIZED/,
      );
    });
  });

  describe("myOrgs", () => {
    it("returns only the orgs the caller is a member of", async () => {
      const alice = await makeUser(testDb.client);
      const bob = await makeUser(testDb.client);
      await makeOrg(testDb.client, { name: "Alice's", ownerId: alice.id });
      await makeOrg(testDb.client, { name: "Bob's", ownerId: bob.id });
      await makeOrg(testDb.client, { name: "Alice and Bob's", ownerId: alice.id });

      const caller = await makeAppCaller({ asUser: alice });
      const orgs = await caller.org.myOrgs();
      const names = orgs.map((o) => o.name).sort();
      expect(names).toEqual(["Alice and Bob's", "Alice's"]);
    });

    it("hides soft-deleted orgs", async () => {
      const alice = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { ownerId: alice.id });
      await testDb.client.org.update({
        where: { id: org.id },
        data: { deletedAt: new Date() },
      });

      const caller = await makeAppCaller({ asUser: alice });
      const orgs = await caller.org.myOrgs();
      expect(orgs).toEqual([]);
    });
  });

  describe("updateOrg", () => {
    it("ADMIN can rename the org", async () => {
      const alice = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: alice.id,
        ownerRole: "ADMIN",
      });
      const caller = await makeAppCaller({ asUser: alice });

      const updated = await caller.org.updateOrg({
        id: org.id,
        name: "Renamed",
      });
      expect(updated.name).toBe("Renamed");
    });

    it("MEMBER cannot update the org", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
      });
      const caller = await makeAppCaller({ asUser: member });

      await expect(
        caller.org.updateOrg({ id: org.id, name: "Hack" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("non-member cannot update the org", async () => {
      const alice = await makeUser(testDb.client);
      const eve = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { ownerId: alice.id });
      const caller = await makeAppCaller({ asUser: eve });

      await expect(
        caller.org.updateOrg({ id: org.id, name: "Pwned" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("deleteOrg", () => {
    it("ADMIN soft-deletes the org", async () => {
      const alice = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: alice.id,
        ownerRole: "ADMIN",
      });
      const caller = await makeAppCaller({ asUser: alice });

      await caller.org.deleteOrg({ id: org.id });

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(alice.id);
    });

    it("MEMBER cannot delete the org", async () => {
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
      });
      const caller = await makeAppCaller({ asUser: member });
      await expect(caller.org.deleteOrg({ id: org.id })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("addUserToOrg", () => {
    it("ADMIN can add an existing user as MEMBER", async () => {
      const admin = await makeUser(testDb.client);
      const newbie = await makeUser(testDb.client, {
        email: "newbie@org-test.local",
      });
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      const caller = await makeAppCaller({ asUser: admin });

      const orgUser = await caller.org.addUserToOrg({
        orgId: org.id,
        userEmail: newbie.email,
        role: "MEMBER",
      });
      expect(orgUser.userId).toBe(newbie.id);
      expect(orgUser.role).toBe("MEMBER");
    });

    it("rejects unknown emails with NOT_FOUND", async () => {
      const admin = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      const caller = await makeAppCaller({ asUser: admin });

      await expect(
        caller.org.addUserToOrg({
          orgId: org.id,
          userEmail: "ghost@nowhere.local",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects re-adding an existing member with CONFLICT", async () => {
      const admin = await makeUser(testDb.client);
      const member = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: admin.id,
        ownerRole: "ADMIN",
      });
      await testDb.client.orgUser.create({
        data: { orgId: org.id, userId: member.id, role: "MEMBER" },
      });
      const caller = await makeAppCaller({ asUser: admin });

      await expect(
        caller.org.addUserToOrg({
          orgId: org.id,
          userEmail: member.email,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("MEMBER cannot add users", async () => {
      const member = await makeUser(testDb.client);
      const target = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, {
        ownerId: member.id,
        ownerRole: "MEMBER",
      });
      const caller = await makeAppCaller({ asUser: member });
      await expect(
        caller.org.addUserToOrg({
          orgId: org.id,
          userEmail: target.email,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});
