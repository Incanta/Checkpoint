/**
 * Which paths the app stores (src/app/src/server/repo-path.ts). Paths are
 * handed back to every daemon that pulls, which writes and deletes there, so a
 * path that climbs out of the workspace, names its .checkpoint directory, or
 * cannot exist on some OS loses files on every machine that syncs it. Moved
 * here from the data-loss red team (DL-03, DL-09, DL-16, DL-17, DL-23).
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
import {
  canonicalPathProblem,
  namesCheckpointDir,
  portablePathProblem,
} from "~/server/repo-path";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

interface Mod {
  path: string;
  delete?: boolean;
  oldPath?: string;
  baseChangelist?: number | null;
}

describe("repo path rules", () => {
  it.each([
    "../escape.txt",
    "Content/../../escape.txt",
    "./a.txt",
    "Content/./a.txt",
    "Content//a.txt",
    "/rooted.txt",
    "Content/a.txt/",
    "C:/Windows/System32/drivers/etc/hosts",
    "c:relative.txt",
    "",
    "Content/..",
    "a/\u0000b",
    "a/\u001fb",
    "a/\u007fb",
    "lone\ud800.txt",
    "lone\udc00.txt",
    `${"a/".repeat(600)}x`,
    ".checkpoint/workspace.json",
    ".CHECKPOINT/workspace.json",
    ".checkpoint./state.db",
    ".checkpoint /state.db",
    ".checkpoint::$INDEX_ALLOCATION/workspace.json",
    ".check\u200cpoint/workspace.json",
    "\ufeff.checkpoint/workspace.json",
    "CHECKP~1/workspace.json",
    "checkp~12/workspace.json",
  ])("always refuses %j", (path) => {
    expect(canonicalPathProblem(path)).not.toBeNull();
  });

  it.each([
    "Content/hero.uasset",
    "a",
    ".checkpointrc",
    "Docs/.checkpoint/notes.txt",
    "Docs/emoji \ud83c\udfae.txt",
    "Docs/Caf\u00e9.txt",
    `${"a/".repeat(500)}x`,
    "Source/aux.h",
    "Notes/standup 10:15.txt",
  ])("accepts %j as canonical", (path) => {
    expect(canonicalPathProblem(path)).toBeNull();
  });

  it.each([
    "CON",
    "con.tar.gz",
    "Source/aux.h",
    "Content/NUL/level.umap",
    "Logs/COM1.log",
    "Logs/COM0",
    "Logs/lpt9",
    "Logs/LPT0.txt",
    "Logs/COM\u00b9.txt",
    "Logs/LPT\u00b3",
    "Logs/CONIN$",
    "Logs/conout$.txt",
    "Logs/nul .txt",
    "Content/level.",
    "Content/level ",
    "Content/Maps./arena.umap",
    "Notes/standup 10:15.txt",
    "Docs/what?.txt",
    "Docs/a*b.txt",
    "Docs/a|b.txt",
    'Docs/"quoted".txt',
    "Docs/<draft>.txt",
    "Content/HERO~1.UAS",
    "PROGRA~1/x.txt",
    `Docs/${"\u6587".repeat(100)}.txt`,
    `Docs/${"a".repeat(256)}`,
  ])("refuses %j as unportable", (path) => {
    expect(portablePathProblem(path)).not.toBeNull();
  });

  it.each([
    "Content/hero.uasset",
    "Logs/COM10.log",
    "Logs/console.log",
    "Source/auxiliary.h",
    "Content/~temp.txt",
    "Content/hero~.txt",
    "Content/a~b~1.txt",
    "Content/.hidden",
    `Docs/${"a".repeat(255)}`,
    `Docs/${"\u6587".repeat(85)}`,
  ])("accepts %j as portable", (path) => {
    expect(portablePathProblem(path)).toBeNull();
  });

  it("knows the spellings that name .checkpoint", () => {
    expect(namesCheckpointDir(".Checkpoint")).toBe(true);
    expect(namesCheckpointDir(".checkpoint...")).toBe(true);
    expect(namesCheckpointDir(".checkpoint:$I30:$INDEX_ALLOCATION")).toBe(true);
    expect(namesCheckpointDir("checkpoint")).toBe(false);
    expect(namesCheckpointDir(".checkpoint-backup")).toBe(false);
  });
});

describe("repo paths at the API", () => {
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

  function submit(mods: Mod[], versionIndex = "fake.lvi") {
    return caller.changelist.createChangelist({
      message: mods.map((m) => m.path).join(", "),
      repoId,
      versionIndex,
      branchName: "main",
      modifications: mods.map((m) => ({
        path: m.path,
        delete: m.delete ?? false,
        ...(m.oldPath !== undefined && { oldPath: m.oldPath }),
        ...(m.baseChangelist !== undefined && {
          baseChangelist: m.baseChangelist,
        }),
      })),
      keepCheckedOut: false,
      workspaceId,
    });
  }

  async function headTree(): Promise<Record<string, number>> {
    const branch = await testDb.client.branch.findFirstOrThrow({
      where: { repoId, name: "main" },
    });
    return Object.fromEntries(
      await getStateTreePaths(testDb.client, repoId, branch.headNumber),
    );
  }

  /** The paths, of those given, that the server accepted as new files. */
  async function accepted(paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const candidate of paths) {
      const ok = await submit([{ path: candidate, baseChangelist: null }]).then(
        () => true,
        () => false,
      );
      if (ok) out.push(candidate);
    }
    return out;
  }

  /** Stores a path the rules now refuse, as an older server would have. */
  async function grandfather(path: string): Promise<number> {
    await testDb.client.repo.update({
      where: { id: repoId },
      data: { pathPortability: false },
    });
    const cl = await submit([{ path, baseChangelist: null }]);
    await testDb.client.repo.update({
      where: { id: repoId },
      data: { pathPortability: true },
    });
    return cl.number;
  }

  it.each([
    "../escape.txt",
    "Content/../../escape.txt",
    "Content\\..\\..\\escape.txt",
    "./a.txt",
    "Content/./a.txt",
    "Content//a.txt",
    "/rooted.txt",
    "Content/a.txt/",
    "C:/Windows/System32/drivers/etc/hosts",
  ])(
    "refuses a path that is not a canonical repo-relative path: %s",
    async (path) => {
      await expect(
        submit([{ path, baseChangelist: null }]),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
  );

  it("refuses a rename from a path that climbs out of the workspace", async () => {
    await expect(
      submit([{ path: "a.txt", oldPath: "../a.txt", baseChangelist: null }]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts backslashes as separators", async () => {
    await submit([{ path: "Content\\Maps\\arena.umap", baseChangelist: null }]);
    expect(Object.keys(await headTree())).toEqual(["Content/Maps/arena.umap"]);
  });

  it.each([
    "Content//hero.uasset",
    "/Content/hero.uasset",
    "Content/hero.uasset/",
    // Windows: the file's main data stream, and its 8.3 short name.
    "Content/hero.uasset::$DATA",
    "Content/HERO~1.UAS",
  ])(
    "does not let %s past someone else's exclusive claim on Content/hero.uasset",
    async (spelling) => {
      // The claim check looks up File rows by the path as spelled, while the
      // tree and Windows fold these spellings onto the claimed file.
      const added = (
        await submit([{ path: "Content/hero.uasset", baseChangelist: null }])
      ).number;
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
            { path: spelling, delete: false, baseChangelist: added },
          ],
          keepCheckedOut: false,
          workspaceId: bobsWorkspace.id,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/FORBIDDEN|BAD_REQUEST/),
      });
      expect((await headTree())["Content/hero.uasset"]).toBe(added);
    },
  );

  it("refuses names Windows reserves for devices", async () => {
    expect(
      await accepted([
        "CON",
        "Source/aux.h",
        "Content/Con.uasset",
        "Content/NUL/level.umap",
        "Logs/COM1.log",
        "Logs/lpt9",
        "Logs/COM\u00b9.txt",
        "Logs/CONIN$",
      ]),
    ).toEqual([]);
  });

  it("refuses names that end in a dot or a space", async () => {
    expect(
      await accepted([
        "Content/level.",
        "Content/level ",
        "Content/Maps./arena.umap",
        "Content/Maps /arena.umap",
      ]),
    ).toEqual([]);
  });

  it("refuses characters Windows does not allow in names", async () => {
    expect(
      await accepted([
        "Notes/standup 10:15.txt",
        "Docs/what?.txt",
        "Docs/a*b.txt",
        "Docs/a|b.txt",
        'Docs/"quoted".txt',
        "Docs/<draft>.txt",
        "Docs/tab\there.txt",
        "Docs/line\nbreak.txt",
      ]),
    ).toEqual([]);
  });

  it("refuses a name longer than Linux filesystems allow", async () => {
    expect(await accepted([`Docs/${"\u6587".repeat(100)}.txt`])).toEqual([]);
  });

  it("refuses paths in a workspace's .checkpoint directory, in every spelling a filesystem folds onto it", async () => {
    expect(
      await accepted([
        ".checkpoint/workspace.json",
        ".CHECKPOINT/workspace.json",
        ".Checkpoint/state.db",
        "CHECKP~1/workspace.json",
        ".checkpoint./workspace.json",
        ".CHECKPOINT::$INDEX_ALLOCATION/workspace.json",
        ".check\u200cpoint/workspace.json",
      ]),
    ).toEqual([]);
  });

  it("refuses .checkpoint even when the repo does not ask for portability", async () => {
    await testDb.client.repo.update({
      where: { id: repoId },
      data: { pathPortability: false },
    });
    expect(
      await accepted([".checkpoint/workspace.json", "CHECKP~1/x.json"]),
    ).toEqual([]);
    expect(await accepted(["Source/aux.h", "Notes/10:15.txt"])).toEqual([
      "Source/aux.h",
      "Notes/10:15.txt",
    ]);
  });

  it("keeps working with a path stored before the rules, and can delete it", async () => {
    const added = await grandfather("Source/aux.h");

    const edited = await submit([
      { path: "Source/aux.h", baseChangelist: added },
    ]);
    expect((await headTree())["Source/aux.h"]).toBe(edited.number);

    await submit([
      { path: "Source/aux.h", delete: true, baseChangelist: edited.number },
      { path: "Source/aux_.h", oldPath: "Source/aux.h", baseChangelist: null },
    ]);
    expect(Object.keys(await headTree())).toEqual(["Source/aux_.h"]);
  });

  it("stores names that share half of an astral character as written", async () => {
    // U+1F3AE and U+1F3AF share their high surrogate. The tree's prefix
    // compression used to split the pair and decode the second name lossily.
    const names = ["Docs/\u{1f3ae} plan.txt", "Docs/\u{1f3af} plan.txt"];
    await submit(names.map((path) => ({ path, baseChangelist: null })));
    expect(Object.keys(await headTree()).sort()).toEqual([...names].sort());
  });

  it("lists paths stored before the rules in the audit", async () => {
    await grandfather("Source/aux.h");
    await submit([{ path: "Source/main.c", baseChangelist: null }]);
    expect(await caller.repo.auditPaths({ id: repoId })).toEqual([
      {
        branch: "main",
        path: "Source/aux.h",
        problem: "a name Windows reserves for a device",
        rule: "portable",
      },
    ]);
  });

  it("can delete a path that should never have been stored", async () => {
    // As a server from before the rules could hold.
    const stored = await testDb.client.repo.findUniqueOrThrow({
      where: { id: repoId },
    });
    expect(stored.pathPortability).toBe(true);
    await expect(
      submit([{ path: "../escape.txt", delete: true }]),
    ).resolves.toBeDefined();
  });

  it("refuses a changelist that names no version index for the files it writes", async () => {
    // Delete-only changelists upload nothing, so they name none.
    const added = (
      await submit([{ path: "Content/level.txt", baseChangelist: null }])
    ).number;
    await expect(
      submit([{ path: "Content/level.txt", baseChangelist: added }], ""),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      submit(
        [{ path: "Content/level.txt", delete: true, baseChangelist: added }],
        "",
      ),
    ).resolves.toBeDefined();
  });
});
