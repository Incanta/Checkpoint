/**
 * The Team Sync reconcile (reconcileSyncFilter in
 * src/core/daemon/src/util/team-sync/sync-pipeline.ts) deletes the files a
 * workspace's sync filter excludes. It must never delete work: not when the
 * repo config cannot be read (an unknown filter is not an empty one), not a
 * file with local work in it, and not in a way that leaves files it did remove
 * looking deleted by the user. A filter that widens brings back what it left
 * out. Moved here from the data-loss red team (DL-02, DL-04, DL-22).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts).
 */
import type { TeamSyncConfig } from "@checkpointvcs/common";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("~/server/repo-path", async (importOriginal) =>
  (await import("../harness/repo-path-switch")).repoPathModule(importOriginal),
);
vi.mock(
  "@checkpointvcs/longtail-addon",
  async () => (await import("../harness/stack")).fakeAddon,
);
vi.mock("@checkpointvcs/common", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stack = await import("../harness/stack");
  return {
    ...actual,
    CreateApiClientAuth: stack.createApiClientAuth,
    GetAuthConfigUser: stack.getAuthConfigUser,
  };
});
vi.mock(
  "../../../core/daemon/src/daemon-config.js",
  async () => (await import("../harness/stack")).fakeDaemonConfigModule,
);
vi.mock(
  "../../../core/daemon/src/logging.js",
  async () => (await import("../harness/stack")).fakeLoggingModule,
);

import { createTestDb, type TestDb } from "../harness/db";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { getWorkspaceState } from "../../../core/daemon/src/util/util.js";
import {
  apiAs,
  backupsContaining,
  describeFile,
  exists,
  fileIn,
  holdOpen,
  makeScene,
  overrides,
  pendingChanges,
  put,
  read,
  resetStack,
  setTeamSync,
  stage,
  stageAndSubmit,
  survives,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

/** A repo config with two default-on categories: code and content. */
const repoConfig: TeamSyncConfig = {
  version: 1,
  syncCategories: [
    {
      id: "code",
      name: "Code",
      paths: ["Source/"],
      enabledByDefault: true,
      requires: [],
      hidden: false,
    },
    {
      id: "content",
      name: "Content",
      paths: ["Content/"],
      enabledByDefault: true,
      requires: [],
      hidden: false,
    },
  ],
  presets: [],
  buildSteps: [],
  artifacts: [],
  contentBadges: [],
  tools: [],
  forceClean: { changelists: [] },
};

const windows = process.platform === "win32";

// Each test runs two daemons' worth of submits and pulls (and the Windows
// lock tests start a PowerShell), which hosted runners can take well past the
// suite's default timeout on.
describe("the Team Sync reconcile", { timeout: 120_000 }, () => {
  let testDb: TestDb;
  let scene: Scene | undefined;

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
    resetStack();
    scene = await makeScene(testDb.client);

    const { alice, bob } = scene;
    await put(alice, "Source/game.cpp", "int main() { return 0; }\n");
    await put(alice, "Content/level.txt", "level, as submitted\n");
    await put(alice, "Content/hero.uasset", "binary hero\n");
    await put(alice, "Plugins/MyPlugin/plugin.txt", "a plugin bob works on\n");
    await stageAndSubmit(alice, ["Source", "Content", "Plugins"]);
    await syncLatest(bob);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  const tracked = async (seat: Scene["bob"]) =>
    Object.keys((await getWorkspaceState(seat.root, "sqlite")).files).sort();

  it("does not delete a locally edited file when the filter is narrowed, and keeps it pending", async () => {
    const { bob } = scene!;
    await put(
      bob,
      "Content/level.txt",
      "level, plus an afternoon of bob's edits\n",
    );

    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    const result = (await syncLatest(bob)) as { filterKept?: string[] };

    expect(await read(bob, "Source/game.cpp")).toContain("int main");
    expect(
      await survives(bob, "Content/level.txt", "an afternoon of bob's edits"),
      await describeFile(bob, "Content/level.txt"),
    ).toBe(true);
    expect(result.filterKept).toEqual(["Content/level.txt"]);
    expect(Object.keys(await pendingChanges(bob))).toEqual([
      "Content/level.txt",
    ]);
    // The unedited ones are gone.
    expect(exists(bob, "Content/hero.uasset")).toBe(false);
    expect(exists(bob, "Plugins/MyPlugin/plugin.txt")).toBe(false);
  });

  it("does not delete a file this workspace holds a claim on", async () => {
    const { bob } = scene!;
    await apiAs(bob).file.checkout({
      repoId: bob.workspace.repoId,
      workspaceId: bob.workspace.id,
      filePath: "Content/hero.uasset",
    });

    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    await syncLatest(bob);

    expect(exists(bob, "Content/hero.uasset")).toBe(true);
    expect(await tracked(bob)).toContain("Content/hero.uasset");
  });

  it("does not delete a staged file", async () => {
    const { bob } = scene!;
    await put(bob, "Content/level.txt", "level, staged\n");
    await stage(bob, ["Content/level.txt"]);

    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    await syncLatest(bob);

    expect(await read(bob, "Content/level.txt")).toBe("level, staged\n");
  });

  it("deletes nothing when it cannot read this workspace's claims", async () => {
    const { bob } = scene!;
    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    overrides.procedures = {
      file: {
        getWorkspaceClaims: async () => {
          throw new Error("503 Service Unavailable");
        },
      },
    };

    await syncLatest(bob);

    expect(exists(bob, "Content/level.txt")).toBe(true);
    expect(exists(bob, "Plugins/MyPlugin/plugin.txt")).toBe(true);
  });

  it("forgets a file that was already deleted from disk when the filter excludes it", async () => {
    // Not a local change worth keeping: nothing is there to keep, and it
    // must not stay behind as a pending delete either.
    const { bob } = scene!;
    await import("node:fs/promises").then((fs) =>
      fs.rm(fileIn(bob, "Content/level.txt")),
    );
    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    await syncLatest(bob);

    expect(await pendingChanges(bob)).toEqual({});
    expect(await tracked(bob)).toEqual(["Source/game.cpp"]);
  });

  it("brings files back when the filter widens again", async () => {
    // Nothing changed upstream, so no diff mentions them: the pull has to
    // look for what the wider filter now includes.
    const { bob } = scene!;
    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    await syncLatest(bob);
    expect(exists(bob, "Content/level.txt")).toBe(false);

    await setTeamSync(bob, { customIncludeRules: ["Source/", "Content/"] });
    await syncLatest(bob);
    expect(await read(bob, "Content/level.txt")).toBe("level, as submitted\n");
    expect(exists(bob, "Plugins/MyPlugin/plugin.txt")).toBe(false);

    await setTeamSync(bob, {});
    await syncLatest(bob);
    expect(await read(bob, "Plugins/MyPlugin/plugin.txt")).toBe(
      "a plugin bob works on\n",
    );
    expect(await pendingChanges(bob)).toEqual({});
  });

  it("brings files back without overwriting an untracked file at the same path", async () => {
    const { bob } = scene!;
    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    await syncLatest(bob);
    await put(bob, "Content/level.txt", "bob's own scratch file\n");

    await setTeamSync(bob, { customIncludeRules: ["Source/", "Content/"] });
    await syncLatest(bob);

    const kept =
      (await survives(bob, "Content/level.txt", "scratch file")) ||
      (await backupsContaining(bob, "scratch file")).length > 0;
    expect(kept).toBe(true);
  });

  describe("when the repo config cannot be read for one sync", () => {
    beforeEach(async () => {
      const { bob } = scene!;
      overrides.teamSyncConfig = async () => ({ config: repoConfig });
      await setTeamSync(bob, { customIncludeRules: ["Plugins/MyPlugin/"] });
      await syncLatest(bob); // filter: code + content + the plugin; nothing excluded
      expect(exists(bob, "Content/level.txt")).toBe(true);

      await put(
        bob,
        "Content/level.txt",
        "level, plus an afternoon of bob's edits\n",
      );
      overrides.teamSyncConfig = async () => {
        throw new Error("503 Service Unavailable");
      };
      await syncLatest(bob);
    });

    it("keeps every file the real filter includes, and the local edit", async () => {
      const { bob } = scene!;
      expect(await describeFile(bob, "Source/game.cpp")).toContain("int main");
      expect(
        await survives(bob, "Content/level.txt", "an afternoon of bob's edits"),
      ).toBe(true);
      expect(exists(bob, "Content/hero.uasset")).toBe(true);
    });

    it("still has every file once the config can be read again", async () => {
      const { bob } = scene!;
      overrides.teamSyncConfig = async () => ({ config: repoConfig });
      await syncLatest(bob);

      expect(await describeFile(bob, "Source/game.cpp")).toContain("int main");
      expect(exists(bob, "Content/level.txt")).toBe(true);
      expect(Object.keys(await pendingChanges(bob))).toEqual([
        "Content/level.txt",
      ]);
    });
  });

  it.runIf(windows)(
    "does not leave the files it removed looking deleted when it cannot remove one",
    async () => {
      // The last excluded file is open in the Unreal Editor, so its delete
      // fails. The sync carries on and says so; the files removed before it
      // left the state, and the locked one is still tracked.
      const { alice, bob } = scene!;
      await put(alice, "Content/level1.txt", "level 1\n");
      await put(alice, "Content/level2.txt", "level 2\n");
      await stageAndSubmit(alice, ["Content/level1.txt", "Content/level2.txt"]);
      await syncLatest(bob);

      const order = Object.keys(
        (await getWorkspaceState(bob.root, "sqlite")).files,
      ).filter((p) => p.startsWith("Content/"));
      const locked = order.at(-1)!;
      await setTeamSync(bob, { customIncludeRules: ["Source/"] });

      const release = await holdOpen(fileIn(bob, locked), "read");
      let result: { filterFailed?: { path: string }[] };
      try {
        result = (await syncLatest(bob)) as typeof result;
      } finally {
        await release();
      }

      expect(result.filterFailed?.map((f) => f.path)).toEqual([locked]);
      const pending = await pendingChanges(bob);
      expect(
        Object.keys(pending).filter((p) => pending[p] === "Deleted"),
      ).toEqual([]);
      expect(await tracked(bob)).toEqual(["Source/game.cpp", locked].sort());
    },
  );
});
