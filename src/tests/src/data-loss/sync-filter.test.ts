/**
 * Red team: Team Sync's sync filter deletes tracked files the filter excludes,
 * after every pull, including scheduled syncs that run with nobody watching.
 *
 * The deletion is a bare `fs.rm` per path (reconcileSyncFilter in
 * util/team-sync/sync-pipeline.ts): no check for local changes, no backup.
 * And the filter it applies is built from whatever repo config the daemon
 * could read at that moment.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (see ./stack.ts). See ./README.md.
 */
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

vi.mock(
  "@checkpointvcs/longtail-addon",
  async () => (await import("./stack")).fakeAddon,
);
vi.mock("@checkpointvcs/common", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stack = await import("./stack");
  return {
    ...actual,
    CreateApiClientAuth: stack.createApiClientAuth,
    GetAuthConfigUser: stack.getAuthConfigUser,
  };
});
vi.mock(
  "../../../core/daemon/src/daemon-config.js",
  async () => (await import("./stack")).fakeDaemonConfigModule,
);
vi.mock(
  "../../../core/daemon/src/logging.js",
  async () => (await import("./stack")).fakeLoggingModule,
);

import type { TeamSyncConfig } from "@checkpointvcs/common";

import { createTestDb, type TestDb } from "../harness/db";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import {
  backupsContaining,
  describeFile,
  exists,
  makeScene,
  overrides,
  put,
  read,
  resetStack,
  setTeamSync,
  stageAndSubmit,
  survives,
  syncLatest,
  tearDownScene,
  type Scene,
} from "./stack";

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

describe("data loss: Team Sync filter", () => {
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
    await put(alice, "Plugins/MyPlugin/plugin.txt", "a plugin bob works on\n");
    await stageAndSubmit(alice, ["Source", "Content", "Plugins"]);
    await syncLatest(bob);
  });

  afterEach(async () => {
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  it("does not delete a locally edited file when the filter is narrowed", async () => {
    // Bob has been editing a level, then narrows his sync to code only (say,
    // to save disk). The next sync deletes the level outright.
    const { bob } = scene!;
    await put(
      bob,
      "Content/level.txt",
      "level, plus an afternoon of bob's edits\n",
    );

    await setTeamSync(bob, { customIncludeRules: ["Source/"] });
    await syncLatest(bob);

    expect(await read(bob, "Source/game.cpp")).toContain("int main");
    expect(
      await survives(bob, "Content/level.txt", "an afternoon of bob's edits"),
      `${await describeFile(bob, "Content/level.txt")}, and no backup holds Bob's edits`,
    ).toBe(true);
  });

  describe("when the repo config cannot be read for one sync", () => {
    // The fallback is meant to be safe ("a transient API failure never widens
    // into mass deletion"), and it is when the workspace has no rules of its
    // own. With one custom include rule, dropping the repo's categories
    // shrinks the filter to that one rule, and everything else is deleted.
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
      const level = `${await describeFile(bob, "Content/level.txt")}; backups with Bob's edits: ${
        (await backupsContaining(bob, "an afternoon of bob's edits")).length
      }`;
      expect(await describeFile(bob, "Source/game.cpp"), level).toContain(
        "int main",
      );
      expect(
        await survives(bob, "Content/level.txt", "an afternoon of bob's edits"),
        level,
      ).toBe(true);
    });

    it("brings the files back once the config can be read again", async () => {
      const { bob } = scene!;
      overrides.teamSyncConfig = async () => ({ config: repoConfig });
      await syncLatest(bob);

      // The deletion also dropped them from the workspace state, and nothing
      // changed upstream, so no later pull's diff ever mentions them again.
      expect(await describeFile(bob, "Source/game.cpp")).toContain("int main");
      expect(
        exists(bob, "Content/level.txt"),
        "Content/level.txt is still gone",
      ).toBe(true);
    });
  });
});
