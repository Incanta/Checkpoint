// Tests for the `shelf` router: create / list / get / rename / delete and
// the file add/remove path. Premium-only: the Shelf + ShelfFileChange + File
// models don't exist on main.
//
// `submitToBranch` is skipped on purpose. It builds a real changelist on a
// branch via the longtail addon's submit pipeline and is the right kind of
// thing to cover in an integration test rather than a fast in-process one.
// `getFileContent` is skipped for the same reason: it reads bytes from
// the storage layer via the longtail addon.

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

async function bootstrap(testDb: TestDb): Promise<{
  alice: Awaited<ReturnType<typeof makeUser>>;
  bob: Awaited<ReturnType<typeof makeUser>>;
  repo: Awaited<ReturnType<typeof makeRepo>>;
}> {
  const alice = await makeUser(testDb.client);
  const bob = await makeUser(testDb.client);
  const org = await makeOrg(testDb.client, {
    ownerId: alice.id,
    ownerRole: "ADMIN",
    defaultRepoAccess: "WRITE",
  });
  await testDb.client.orgUser.create({
    data: { orgId: org.id, userId: bob.id, role: "MEMBER" },
  });
  const repo = await makeRepo(testDb.client, org.id, alice.id);
  return { alice, bob, repo };
}

describe("shelf router", () => {
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

  describe("create", () => {
    it("persists the shelf, allocates the next CL number, and creates fileChange rows", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      const shelf = await caller.shelf.create({
        repoId: repo.id,
        name: "wip-login",
        description: "trying out new login UI",
        versionIndex: "vi_test",
        modifications: [
          { path: "src/auth/login.ts" },
          { path: "src/auth/login.test.ts" },
        ],
      });

      expect(shelf.name).toBe("wip-login");
      expect(shelf.status).toBe("ACTIVE");
      expect(shelf.authorId).toBe(alice.id);
      // makeRepo already created CL #0 ("Repo Creation"), so the next CL is #1.
      expect(shelf.changelistNumber).toBe(1);
      expect(shelf.fileChanges).toHaveLength(2);
      expect(shelf.fileChanges.map((fc) => fc.file.path).sort()).toEqual([
        "src/auth/login.test.ts",
        "src/auth/login.ts",
      ]);

      // The accompanying dangling CL was actually created.
      const cl = await testDb.client.changelist.findUnique({
        where: {
          repoId_number: { repoId: repo.id, number: shelf.changelistNumber },
        },
      });
      expect(cl?.message).toBe("Shelf: wip-login");
      expect(cl?.parentNumber).toBeNull();
    });

    it("reuses existing File rows instead of inserting duplicates", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      await caller.shelf.create({
        repoId: repo.id,
        name: "first",
        versionIndex: "vi1",
        modifications: [{ path: "src/index.ts" }],
      });
      const fileRowsAfterFirst = await testDb.client.file.findMany({
        where: { repoId: repo.id },
      });

      await caller.shelf.create({
        repoId: repo.id,
        name: "second",
        versionIndex: "vi2",
        modifications: [{ path: "src/index.ts" }, { path: "src/other.ts" }],
      });
      const fileRowsAfterSecond = await testDb.client.file.findMany({
        where: { repoId: repo.id },
      });

      // 1 from first, +1 new from second (src/other.ts), src/index.ts reused.
      expect(fileRowsAfterFirst).toHaveLength(1);
      expect(fileRowsAfterSecond).toHaveLength(2);
    });

    it("rejects duplicate shelf names per repo with CONFLICT", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      await caller.shelf.create({
        repoId: repo.id,
        name: "dup",
        versionIndex: "v",
        modifications: [{ path: "a.ts" }],
      });
      await expect(
        caller.shelf.create({
          repoId: repo.id,
          name: "dup",
          versionIndex: "v",
          modifications: [{ path: "b.ts" }],
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("requires WRITE access", async () => {
      const { repo } = await bootstrap(testDb);
      const stranger = await makeUser(testDb.client);
      const caller = await makeAppCaller({ asUser: stranger });
      await expect(
        caller.shelf.create({
          repoId: repo.id,
          name: "blocked",
          versionIndex: "v",
          modifications: [{ path: "a.ts" }],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("list / get", () => {
    it("list excludes DELETED by default and orders by updatedAt desc", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const first = await caller.shelf.create({
        repoId: repo.id,
        name: "first",
        versionIndex: "v1",
        modifications: [{ path: "a.ts" }],
      });
      // Wait a millisecond so updatedAt differs deterministically.
      await new Promise((r) => setTimeout(r, 5));
      const second = await caller.shelf.create({
        repoId: repo.id,
        name: "second",
        versionIndex: "v2",
        modifications: [{ path: "b.ts" }],
      });
      // Soft-delete first; default list should hide it.
      await caller.shelf.delete({ repoId: repo.id, shelfName: first.name });

      const visible = await caller.shelf.list({ repoId: repo.id });
      expect(visible.map((s) => s.name)).toEqual([second.name]);
    });

    it("list filters by status when one is passed", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const a = await caller.shelf.create({
        repoId: repo.id,
        name: "a",
        versionIndex: "v",
        modifications: [{ path: "f.ts" }],
      });
      await caller.shelf.delete({ repoId: repo.id, shelfName: a.name });

      const deleted = await caller.shelf.list({
        repoId: repo.id,
        status: "DELETED",
      });
      expect(deleted.map((s) => s.name)).toEqual([a.name]);
    });

    it("list filters by authorId", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: alice });
      const bobCaller = await makeAppCaller({ asUser: bob });
      await aliceCaller.shelf.create({
        repoId: repo.id,
        name: "alice-shelf",
        versionIndex: "v",
        modifications: [{ path: "a.ts" }],
      });
      await bobCaller.shelf.create({
        repoId: repo.id,
        name: "bob-shelf",
        versionIndex: "v",
        modifications: [{ path: "b.ts" }],
      });

      const mine = await aliceCaller.shelf.list({
        repoId: repo.id,
        authorId: alice.id,
      });
      expect(mine.map((s) => s.name)).toEqual(["alice-shelf"]);
    });

    it("get returns NOT_FOUND for missing shelves", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      await expect(
        caller.shelf.get({ repoId: repo.id, name: "ghost" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("addFiles / removeFiles", () => {
    it("addFiles extends an existing shelf's fileChanges", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const shelf = await caller.shelf.create({
        repoId: repo.id,
        name: "expandable",
        versionIndex: "v1",
        modifications: [{ path: "a.ts" }],
      });

      await caller.shelf.addFiles({
        repoId: repo.id,
        shelfName: shelf.name,
        versionIndex: "v2",
        modifications: [{ path: "b.ts" }, { path: "c.ts" }],
      });

      const got = await caller.shelf.get({
        repoId: repo.id,
        name: shelf.name,
      });
      expect(got.fileChanges.map((fc) => fc.file.path).sort()).toEqual([
        "a.ts",
        "b.ts",
        "c.ts",
      ]);
    });

    it("addFiles rejects when the shelf is not ACTIVE", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const shelf = await caller.shelf.create({
        repoId: repo.id,
        name: "doomed",
        versionIndex: "v",
        modifications: [{ path: "a.ts" }],
      });
      await caller.shelf.delete({ repoId: repo.id, shelfName: shelf.name });
      await expect(
        caller.shelf.addFiles({
          repoId: repo.id,
          shelfName: shelf.name,
          versionIndex: "v",
          modifications: [{ path: "b.ts" }],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("removeFiles drops the matched fileChanges", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const shelf = await caller.shelf.create({
        repoId: repo.id,
        name: "trim",
        versionIndex: "v1",
        modifications: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
      });

      await caller.shelf.removeFiles({
        repoId: repo.id,
        shelfName: shelf.name,
        versionIndex: "v2",
        filePaths: ["b.ts"],
      });

      const got = await caller.shelf.get({
        repoId: repo.id,
        name: shelf.name,
      });
      expect(got.fileChanges.map((fc) => fc.file.path).sort()).toEqual([
        "a.ts",
        "c.ts",
      ]);
    });
  });

  describe("rename", () => {
    it("renames an ACTIVE shelf in place", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const shelf = await caller.shelf.create({
        repoId: repo.id,
        name: "old-name",
        versionIndex: "v",
        modifications: [{ path: "a.ts" }],
      });

      const renamed = await caller.shelf.rename({
        repoId: repo.id,
        shelfName: shelf.name,
        newName: "new-name",
      });
      expect(renamed.name).toBe("new-name");
      expect(renamed.id).toBe(shelf.id);
    });

    it("rejects renaming to an already-taken name with CONFLICT", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      await caller.shelf.create({
        repoId: repo.id,
        name: "taken",
        versionIndex: "v",
        modifications: [{ path: "a.ts" }],
      });
      const other = await caller.shelf.create({
        repoId: repo.id,
        name: "other",
        versionIndex: "v",
        modifications: [{ path: "b.ts" }],
      });
      await expect(
        caller.shelf.rename({
          repoId: repo.id,
          shelfName: other.name,
          newName: "taken",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("rejects renaming a non-ACTIVE shelf with NOT_FOUND", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const shelf = await caller.shelf.create({
        repoId: repo.id,
        name: "to-delete",
        versionIndex: "v",
        modifications: [{ path: "a.ts" }],
      });
      await caller.shelf.delete({ repoId: repo.id, shelfName: shelf.name });
      await expect(
        caller.shelf.rename({
          repoId: repo.id,
          shelfName: shelf.name,
          newName: "anything",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("delete", () => {
    it("soft-deletes by flipping status to DELETED (row not removed)", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const shelf = await caller.shelf.create({
        repoId: repo.id,
        name: "x",
        versionIndex: "v",
        modifications: [{ path: "a.ts" }],
      });

      await caller.shelf.delete({ repoId: repo.id, shelfName: shelf.name });

      const row = await testDb.client.shelf.findUniqueOrThrow({
        where: { id: shelf.id },
      });
      expect(row.status).toBe("DELETED");
    });

    it("rejects unknown shelf names with NOT_FOUND", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      await expect(
        caller.shelf.delete({ repoId: repo.id, shelfName: "ghost" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
