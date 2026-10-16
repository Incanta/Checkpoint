/**
 * Bringing a feature branch's parent into it (branch.updateFromParent,
 * updateBranchFromParent in src/app/src/server/branch-merge.ts). A merge that
 * conflicts says to update the branch from its parent and resolve there; the
 * update records the parent's head as merged into the branch, so the merge
 * base moves and the branch merges without meeting those changes again.
 * Moved here from the data-loss red team (DL-14).
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

describe("updating a branch from its parent", () => {
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

  const submit = async (branchName: string, mods: Mod[]) =>
    (
      await caller.changelist.createChangelist({
        message: `${branchName}: ${mods.map((m) => m.path).join(", ")}`,
        repoId,
        versionIndex: "fake.lvi",
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
      })
    ).number;

  const write = (branchName: string, ...paths: string[]) =>
    submit(
      branchName,
      paths.map((path) => ({ path })),
    );

  const branchFrom = (parent: string, name: string) =>
    caller.branch.createBranch({
      repoId,
      name,
      type: "FEATURE",
      parentBranchName: parent,
    });

  const merge = (incoming: string, target = "main") =>
    caller.branch.mergeBranch({
      repoId,
      incomingBranchName: incoming,
      targetBranchName: target,
    });

  const update = (
    branchName: string,
    extra: { parentHeadNumber?: number; resolvedInNumber?: number } = {},
  ) => caller.branch.updateFromParent({ repoId, branchName, ...extra });

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

  it("merges once a conflict is resolved on the branch, as the refusal says to", async () => {
    await write("main", "both.txt", "other.txt");
    await branchFrom("main", "feature");
    const f1 = await write("feature", "both.txt");
    await write("feature", "feature-only.txt");
    await write("main", "both.txt");
    await expect(merge("feature")).rejects.toThrow(/Update feature from main/);

    const resolved = await submit("feature", [
      { path: "both.txt", baseChangelist: f1 },
    ]);
    await update("feature", { resolvedInNumber: resolved });

    await merge("feature");

    const main = await treeOf("main");
    expect(main["both.txt"]).toBe(resolved);
    expect(main["feature-only.txt"]).toBeDefined();
  });

  it("brings the parent's changes onto the branch when nothing conflicts", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    await write("feature", "f.txt");
    const m = await write("main", "m.txt");
    await write("main", "a.txt");

    const result = await update("feature");

    expect(result.status).toBe("updated");
    const feature = await treeOf("feature");
    expect(feature["m.txt"]).toBe(m);
    expect(feature["f.txt"]).toBeDefined();
    // Merging the branch now carries only its own change.
    await merge("feature");
    expect((await treeOf("main"))["f.txt"]).toBeDefined();
  });

  it("refuses with the conflicting paths, and changes nothing", async () => {
    await write("main", "both.txt");
    await branchFrom("main", "feature");
    await write("feature", "both.txt");
    await write("main", "both.txt");
    const before = await head("feature");

    await expect(update("feature")).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("both.txt"),
    });
    expect(await head("feature")).toBe(before);
  });

  it("brings a delete on the parent into the branch", async () => {
    await write("main", "gone.txt", "keep.txt");
    await branchFrom("main", "feature");
    await write("feature", "f.txt");
    const g = (await treeOf("main"))["gone.txt"];
    await submit("main", [
      { path: "gone.txt", delete: true, baseChangelist: g },
    ]);

    await update("feature");

    expect(await treeOf("feature")).not.toHaveProperty("gone.txt");
  });

  it("is up to date when the parent has nothing new", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    await write("feature", "f.txt");

    expect(await update("feature")).toMatchObject({ status: "up-to-date" });
  });

  it("refuses when the parent moved past the head the caller resolved against", async () => {
    await write("main", "a.txt");
    await branchFrom("main", "feature");
    const seen = await write("main", "b.txt");
    await write("main", "c.txt");

    await expect(
      update("feature", { parentHeadNumber: seen }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a resolution that is not on the branch", async () => {
    await write("main", "both.txt");
    await branchFrom("main", "feature");
    await write("feature", "both.txt");
    const onMain = await write("main", "both.txt");

    await expect(
      update("feature", { resolvedInNumber: onMain }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("updates a stacked branch from its own parent, and the stack then merges", async () => {
    await write("main", "x.txt");
    await branchFrom("main", "lower");
    await branchFrom("lower", "upper");
    const u = await write("upper", "u.txt");
    const l = await write("lower", "l.txt");

    await update("upper");
    expect((await treeOf("upper"))["l.txt"]).toBe(l);

    await merge("upper", "lower");
    await merge("lower");
    const main = await treeOf("main");
    expect(main["u.txt"]).toBe(u);
    expect(main["l.txt"]).toBe(l);
  });
});
