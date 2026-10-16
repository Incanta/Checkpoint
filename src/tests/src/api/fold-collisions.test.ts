/**
 * Names that are one file on Windows and macOS. NTFS and APFS ignore case
 * (beyond ASCII), and APFS and HFS+ ignore Unicode normalization, so a tree
 * that holds "Content/Hero.txt" and "Content/hero.txt" makes every pull there
 * write two versions into one file. The tree refuses a new name that folds
 * onto another in its directory (applyChanges in src/app/src/server/tree/
 * tree.ts, foldName in src/app/src/server/repo-path.ts). Moved here from the
 * data-loss red team (DL-08, DL-18, and the case spelling of DL-09).
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
import { foldName } from "~/server/repo-path";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

interface Mod {
  path: string;
  delete?: boolean;
  baseChangelist?: number | null;
}

describe("foldName", () => {
  it.each([
    ["Hero.txt", "hero.txt"],
    ["Ärger", "ärger"],
    ["STRASSE", "straße"],
    ["ΣΟΦΙΑ", "σοφια"],
    ["σ", "ς"],
    ["K", "k"],
    ["Café", "Café"],
    ["한글", "한글"],
    ["read‌me", "readme"],
  ])("folds %j and %j together", (a, b) => {
    expect(foldName(a)).toBe(foldName(b));
  });

  it.each([
    ["hero.txt", "hero.txt "],
    ["a", "b"],
    ["İ", "j"],
    ["é", "e"],
  ])("keeps %j and %j apart", (a, b) => {
    expect(foldName(a)).not.toBe(foldName(b));
  });
});

describe("names that fold together, at the API", () => {
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

  function submit(branchName: string, mods: Mod[]) {
    return caller.changelist.createChangelist({
      message: mods.map((m) => m.path).join(", "),
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
    });
  }

  const write = async (branchName: string, ...paths: string[]) =>
    (
      await submit(
        branchName,
        paths.map((path) => ({ path })),
      )
    ).number;

  async function treeOf(branchName: string): Promise<string[]> {
    const branch = await testDb.client.branch.findFirstOrThrow({
      where: { repoId, name: branchName },
    });
    return [
      ...(
        await getStateTreePaths(testDb.client, repoId, branch.headNumber)
      ).keys(),
    ].sort();
  }

  it.each([
    ["the file name", "Content/Hero.txt", "Content/hero.txt"],
    ["a directory name", "Docs/Guide/intro.txt", "docs/guide/intro.txt"],
    ["a non-ASCII letter", "Content/Ärger.txt", "Content/ärger.txt"],
    ["a file and a directory", "Content/Level", "Content/level/arena.umap"],
    ["a directory and a file", "Content/level/arena.umap", "Content/Level"],
    ["a deep directory", "A/B/C/d.txt", "a/b/c/e.txt"],
    [
      "the Unicode normalization of the file name",
      "Docs/Café.txt",
      "Docs/Café.txt",
    ],
    [
      "the Unicode normalization of a directory name",
      "Résumés/alice.txt",
      "Résumés/bob.txt",
    ],
  ])(
    "refuses a new path that differs from an existing one only in %s",
    async (_what, existing, colliding) => {
      await write("main", existing);
      await expect(
        submit("main", [{ path: colliding, baseChangelist: null }]),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await treeOf("main")).toEqual([existing]);
    },
  );

  it("refuses two new paths that fold together in one changelist", async () => {
    await expect(
      submit("main", [
        { path: "Content/Hero.txt", baseChangelist: null },
        { path: "Content/hero.txt", baseChangelist: null },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("names both spellings in the refusal", async () => {
    await write("main", "Content/Hero.txt");
    await expect(
      submit("main", [{ path: "Content/HERO.txt", baseChangelist: null }]),
    ).rejects.toThrow(/Content\/HERO\.txt differs from Content\/Hero\.txt/);
  });

  it("accepts a case-only rename made in one changelist", async () => {
    const added = await write("main", "Content/hero.txt");
    await submit("main", [
      { path: "Content/hero.txt", delete: true, baseChangelist: added },
      { path: "Content/Hero.txt", baseChangelist: null },
    ]);
    expect(await treeOf("main")).toEqual(["Content/Hero.txt"]);
  });

  it("accepts a case-only rename of a directory across all its files", async () => {
    const files = ["docs/a.txt", "docs/b.txt", "docs/sub/c.txt"];
    const added = await write("main", ...files);
    await submit("main", [
      ...files.map((path) => ({ path, delete: true, baseChangelist: added })),
      ...files.map((path) => ({
        path: path.replace(/^docs/, "Docs"),
        baseChangelist: null,
      })),
    ]);
    expect(await treeOf("main")).toEqual([
      "Docs/a.txt",
      "Docs/b.txt",
      "Docs/sub/c.txt",
    ]);
  });

  it("refuses a directory rename that leaves a file behind under the old spelling", async () => {
    const added = await write("main", "docs/a.txt", "docs/b.txt");
    await expect(
      submit("main", [
        { path: "docs/a.txt", delete: true, baseChangelist: added },
        { path: "Docs/a.txt", baseChangelist: null },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("still accepts edits in a repo that already holds two spellings", async () => {
    await testDb.client.repo.update({
      where: { id: repoId },
      data: { pathPortability: false },
    });
    const first = await write("main", "Content/Hero.txt", "Content/hero.txt");
    await testDb.client.repo.update({
      where: { id: repoId },
      data: { pathPortability: true },
    });

    await submit("main", [
      { path: "Content/hero.txt", baseChangelist: first },
      { path: "Content/other.txt", baseChangelist: null },
    ]);
    await submit("main", [
      { path: "Content/hero.txt", delete: true, baseChangelist: first + 1 },
    ]);
    expect(await treeOf("main")).toEqual([
      "Content/Hero.txt",
      "Content/other.txt",
    ]);
  });

  it("lists names a repo already holds in two spellings in the audit, where they start", async () => {
    await testDb.client.repo.update({
      where: { id: repoId },
      data: { pathPortability: false },
    });
    await write("main", "Docs/Guide/intro.txt", "docs/guide/intro.txt");
    await write(
      "main",
      "Content/Hero.txt",
      "Content/hero.txt",
      "Content/ok.txt",
    );

    const audit = await caller.repo.auditPaths({ id: repoId });

    expect(
      audit
        .filter((e) => e.rule === "fold")
        .map((e) => e.path)
        .sort(),
    ).toEqual(["Content/Hero.txt", "Content/hero.txt", "Docs", "docs"]);
  });

  it("allows names that differ only in case when the repo does not ask for portability", async () => {
    await testDb.client.repo.update({
      where: { id: repoId },
      data: { pathPortability: false },
    });
    await write("main", "Content/Hero.txt");
    await write("main", "Content/hero.txt");
    expect(await treeOf("main")).toEqual([
      "Content/Hero.txt",
      "Content/hero.txt",
    ]);
  });

  it("refuses a merge in which each side added one spelling", async () => {
    await write("main", "README.md");
    await caller.branch.createBranch({
      repoId,
      name: "feature",
      type: "FEATURE",
      parentBranchName: "main",
    });
    await write("feature", "Content/hero.txt");
    await write("main", "Content/Hero.txt");

    await expect(
      caller.branch.mergeBranch({
        repoId,
        incomingBranchName: "feature",
        targetBranchName: "main",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await treeOf("main")).toEqual(["Content/Hero.txt", "README.md"]);
  });

  it("does not let content/HERO.uasset, the same file on Windows, past someone else's exclusive claim on Content/hero.uasset", async () => {
    const added = await write("main", "Content/hero.uasset");
    await caller.file.checkout({
      repoId,
      workspaceId,
      filePath: "Content/hero.uasset",
    });
    const bob = await makeUser(testDb.client, { name: "bob" });
    const repo = await testDb.client.repo.findUniqueOrThrow({
      where: { id: repoId },
    });
    await testDb.client.orgUser.create({
      data: { orgId: repo.orgId, userId: bob.id, role: "ADMIN" },
    });
    const bobsWorkspace = await makeWorkspace(
      testDb.client,
      repoId,
      repo.orgId,
      bob.id,
    );
    const asBob = await makeAppCaller({ asUser: bob });

    await expect(
      asBob.changelist.createChangelist({
        message: "bob's hero",
        repoId,
        versionIndex: "bob.lvi",
        branchName: "main",
        modifications: [
          { path: "content/HERO.uasset", delete: false, baseChangelist: null },
        ],
        keepCheckedOut: false,
        workspaceId: bobsWorkspace.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await treeOf("main")).toEqual(["Content/hero.uasset"]);
    void added;
  });
});
