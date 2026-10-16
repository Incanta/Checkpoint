/**
 * Red team: what the app accepts on push, and what merging and deleting
 * branches do with work, checked at the API (in-process routers over the
 * SQLite test database, as in src/api). See ./README.md.
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

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

interface Mod {
  path: string;
  delete?: boolean;
  baseChangelist?: number | null;
}

describe("data loss: server", () => {
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

  function submit(branchName: string, mods: Mod[], versionIndex = "fake.lvi") {
    return caller.changelist.createChangelist({
      message: `${branchName}: ${mods.map((m) => m.path).join(", ")}`,
      repoId,
      versionIndex,
      branchName,
      modifications: mods.map((m) => ({
        path: m.path,
        delete: m.delete ?? false,
        ...(m.baseChangelist !== undefined && {
          baseChangelist: m.baseChangelist,
        }),
      })),
      keepCheckedOut: false,
      workspaceId,
    });
  }

  /** The changelist number of a submit of whole files to a branch. */
  async function write(
    branchName: string,
    ...paths: string[]
  ): Promise<number> {
    return (
      await submit(
        branchName,
        paths.map((path) => ({ path })),
      )
    ).number;
  }

  async function branchFrom(parent: string, name: string) {
    await caller.branch.createBranch({
      repoId,
      name,
      type: "FEATURE",
      parentBranchName: parent,
    });
  }

  async function head(branchName: string): Promise<number> {
    return (
      await testDb.client.branch.findFirstOrThrow({
        where: { repoId, name: branchName },
      })
    ).headNumber;
  }

  async function treeOf(branchName: string): Promise<Record<string, number>> {
    return Object.fromEntries(
      await getStateTreePaths(testDb.client, repoId, await head(branchName)),
    );
  }

  const merge = (incoming: string, target = "main") =>
    caller.branch.mergeBranch({
      repoId,
      incomingBranchName: incoming,
      targetBranchName: target,
    });

  describe("merge", () => {
    it("merges once a conflict is resolved on the branch, as the refusal says to", async () => {
      // The refusal says: bring main into the branch, resolve there, merge
      // again. The only way to put a resolved file on the branch is to submit
      // it there, and that never moves the merge base, so the same path
      // conflicts again forever. The existing suite's "resolved" case deletes
      // and recreates the branch, which throws away everything else on it.
      await write("main", "both.txt", "other.txt");
      await branchFrom("main", "feature");
      const f1 = await write("feature", "both.txt");
      await write("feature", "feature-only.txt");
      await write("main", "both.txt");
      await expect(merge("feature")).rejects.toMatchObject({
        code: "CONFLICT",
      });

      const resolved = (
        await submit("feature", [{ path: "both.txt", baseChangelist: f1 }])
      ).number;

      await merge("feature");

      const main = await treeOf("main");
      expect(main["both.txt"]).toBe(resolved);
      expect(main["feature-only.txt"]).toBeDefined();
    });
  });

  describe("branches", () => {
    it("refuses to delete a branch whose changelists were never merged, unless told to discard them", async () => {
      // Archiving with claims outstanding needs an explicit flag
      // (releaseOutstandingClaims); deleting a branch full of unmerged work
      // needs nothing. Its changelists stay in the database, but no branch
      // reaches them any more, so history, pulls, and merge requests cannot.
      await write("main", "a.txt");
      await branchFrom("main", "feature");
      await write("feature", "a week of work.txt");

      await expect(
        caller.branch.deleteBranch({ repoId, branchName: "feature" }),
      ).rejects.toThrow();

      expect(await head("feature")).toBeGreaterThan(1);
    });
  });
});
