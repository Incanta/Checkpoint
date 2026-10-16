/**
 * Submits update the state tree along the edited paths, and reads ask the
 * tree for just the paths or folder they need. These pin what callers see:
 * the file count each changelist records, path collisions refused instead of
 * silently dropping a directory, and folder listings equal to what the old
 * whole-map scan produced.
 *
 * Every submit here also runs in the suite's "strict" incremental mode, which
 * rebuilds the whole tree alongside and throws on any difference.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeOrg, makeRepo, makeUser, makeWorkspace } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { getStateTreePaths, stateTreeFileCount } from "~/server/state-tree";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

describe("state tree reads and writes through the routers", () => {
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
    const org = await makeOrg(testDb.client, { ownerId: owner.id, ownerRole: "ADMIN" });
    const repo = await makeRepo(testDb.client, org.id, owner.id);
    const workspace = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
    caller = await makeAppCaller({ asUser: owner });
    repoId = repo.id;
    workspaceId = workspace.id;
  });

  function submit(mods: { path: string; delete?: boolean }[]) {
    return caller.changelist.createChangelist({
      message: "test",
      repoId,
      versionIndex: "test.lvi",
      branchName: "main",
      modifications: mods.map((m) => ({ path: m.path, delete: m.delete ?? false })),
      keepCheckedOut: false,
      workspaceId,
    });
  }

  const recordedCount = async (number: number) =>
    (
      await testDb.client.changelist.findUniqueOrThrow({
        where: { repoId_number: { repoId, number } },
        select: { fileCount: true },
      })
    ).fileCount;

  it("records each changelist's file count from its parent's", async () => {
    const a = await submit([{ path: "a.txt" }, { path: "d/b.txt" }, { path: "d/e/c.txt" }]);
    // Fixture changelists predate the count; the first submit's parent is
    // counted from its tree once and the count carries on from there.
    const base = await stateTreeFileCount(testDb.client, repoId, a.number - 1);
    expect(await stateTreeFileCount(testDb.client, repoId, a.number)).toBe(base + 3);

    // Re-submitting an existing path, deleting one, deleting a missing one,
    // adding and deleting the same path, and a path given twice.
    const b = await submit([
      { path: "a.txt" },
      { path: "d/b.txt", delete: true },
      { path: "never/there.txt", delete: true },
      { path: "f.txt" },
      { path: "f.txt", delete: true },
      { path: "g.txt" },
      { path: "g.txt" },
    ]);
    const count = await recordedCount(b.number);
    expect(count).toBe(base + 3);
    expect(count).toBe((await getStateTreePaths(testDb.client, repoId, b.number)).size);
  });

  it("refuses a submit that would make a path both a file and a directory", async () => {
    await submit([{ path: "Content/Map" }]);
    await expect(submit([{ path: "Content/Map/Actor.uasset" }])).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(submit([{ path: "Content" }])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(submit([{ path: "x/y" }, { path: "x" }])).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // Replacing the file with a directory in one submit is fine.
    await submit([{ path: "Content/Map", delete: true }, { path: "Content/Map/Actor.uasset" }]);
  });

  it("lists folders exactly as a scan of the whole state would", async () => {
    const paths = [
      "README.md",
      "Source/Game/Game.cpp",
      "Source/Game/Game.h",
      "Source/Game/Private/Impl.cpp",
      "Content/Maps/Main.umap",
      "Content/Maps/Sub/Level.umap",
      "Content/Characters/Hero.uasset",
    ];
    const cl = await submit(paths.map((path) => ({ path })));
    const state = await getStateTreePaths(testDb.client, repoId, cl.number);

    for (const folder of ["", "Source", "Source/Game", "Source/Game/", "Content/Maps", "Nope"]) {
      const result = await caller.file.listFolder({
        repoId,
        changelistNumber: cl.number,
        folderPath: folder,
      });
      const prefix = folder === "" ? "" : folder.endsWith("/") ? folder : `${folder}/`;
      const expectedFiles = [...state]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map(([p, lastCl]) => ({ name: p.slice(prefix.length), path: p, lastCl, isArtifact: false }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const expectedFolders = [
        ...new Set(
          [...state.keys()]
            .filter((p) => p.startsWith(prefix) && p.slice(prefix.length).includes("/"))
            .map((p) => p.slice(prefix.length).split("/")[0]!),
        ),
      ].sort();

      expect([...result.files].sort((a, b) => a.name.localeCompare(b.name)), folder).toEqual(
        expectedFiles,
      );
      expect([...result.folders].sort(), folder).toEqual(expectedFolders);
      expect(result.totalFileCount).toBe(state.size);
    }
  });
});
