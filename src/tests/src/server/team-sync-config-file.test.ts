/**
 * The Team Sync config is the repo's committed `teamsync.yaml` at the root
 * (src/app/src/server/team-sync/config.ts).
 *
 * Committed through the daemon and read back through the real app routers,
 * with only the native addon faked (src/harness/stack.ts). This is also where
 * the nested-link checks that need a real committed config are tested.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  apiAs,
  headOf,
  makeScene,
  put,
  resetStack,
  stageAndSubmit,
  submitDirect,
  tearDownScene,
  type Scene,
} from "../harness/stack";

const yamlWith = (body: string) => `version: 1\n${body}`;

describe("teamsync.yaml at the repo root", { timeout: 120_000 }, () => {
  let testDb: TestDb;
  let scene: Scene;

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
  });

  afterEach(async () => {
    closeAllStateStores();
    await tearDownScene(scene);
  });

  const getConfig = () =>
    apiAs(scene.alice).teamSync.getConfig({ repoId: scene.repoId });

  const commitConfig = async (yaml: string) => {
    await put(scene.alice, "teamsync.yaml", yaml);
    await stageAndSubmit(scene.alice, ["teamsync.yaml"]);
    return headOf(testDb.client, scene.repoId, "main");
  };

  it("commits like any file and is read back", async () => {
    const cl = await commitConfig(
      yamlWith(
        "linkedRepos:\n  - repo: UE5\n    branch: main\n    changelist: 7\n",
      ),
    );
    const result = await getConfig();
    expect(result.errors).toBeNull();
    expect(result.sourceChangelistNumber).toBe(cl);
    expect(result.config?.linkedRepos).toEqual([
      { repo: "UE5", branch: "main", changelist: 7, enabledByDefault: true },
    ]);
  });

  it("marks the changelists that move a pin in the browser's metadata", async () => {
    const link = (cl: number) =>
      yamlWith(
        `linkedRepos:\n  - repo: UE5\n    branch: main\n    changelist: ${cl}\n`,
      );
    const added = await commitConfig(link(7));
    const moved = await commitConfig(link(9));
    const same = await commitConfig(`${link(9)}# a comment\n`);
    await put(scene.alice, "Source/a.cpp", "x");
    await stageAndSubmit(scene.alice, ["Source"]);
    const other = await headOf(testDb.client, scene.repoId, "main");

    const meta = await apiAs(scene.alice).teamSync.getChangelistMeta({
      repoId: scene.repoId,
      changelistNumbers: [added, moved, same, other],
    });
    expect(meta[String(added)]?.pinChanges).toEqual([
      { repo: "UE5", from: null, to: { branch: "main", changelist: 7 } },
    ]);
    expect(meta[String(moved)]?.pinChanges).toEqual([
      {
        repo: "UE5",
        from: { branch: "main", changelist: 7 },
        to: { branch: "main", changelist: 9 },
      },
    ]);
    expect(meta[String(same)]?.pinChanges).toEqual([]);
    expect(meta[String(other)]?.pinChanges).toEqual([]);
  });

  it("has no config when the repo commits none", async () => {
    await put(scene.alice, "Source/a.cpp", "x");
    await stageAndSubmit(scene.alice, ["Source"]);
    expect(await getConfig()).toEqual({
      config: null,
      sourceChangelistNumber: null,
      errors: null,
    });
  });

  describe("nested links", () => {
    const nested = (path: string) =>
      yamlWith(
        `linkedRepos:\n  - repo: StudioPlugins\n    branch: main\n    changelist: 1\n    path: ${path}\n`,
      );

    it("rejects a config mounting a linked repo onto files the repo tracks", async () => {
      await put(scene.alice, "Plugins/Studio/Old.uplugin", "{}");
      await stageAndSubmit(scene.alice, ["Plugins"]);
      await commitConfig(nested("plugins/studio"));

      const result = await getConfig();
      expect(result.config).toBeNull();
      expect(result.errors?.join("\n")).toMatch(
        /linkedRepos\.0\.path: "plugins\/studio" is where StudioPlugins would be mounted, but this repo tracks files there \(Plugins\/Studio\/Old\.uplugin\)/,
      );
    });

    it("accepts the mount once the files are gone", async () => {
      await put(scene.alice, "Plugins/Studio/Old.uplugin", "{}");
      await stageAndSubmit(scene.alice, ["Plugins"]);
      await submitDirect(scene.alice, { remove: ["Plugins/Studio/Old.uplugin"] });
      await commitConfig(nested("Plugins/Studio"));
      expect((await getConfig()).errors).toBeNull();
    });

    it("refuses a submit adding files under a mount path, and allows other files", async () => {
      await commitConfig(nested("Plugins/Studio"));

      await expect(
        submitDirect(scene.alice, {
          write: { "Plugins/Studio/New.uplugin": "{}" },
        }),
      ).rejects.toThrow(
        /Cannot submit Plugins\/Studio\/New\.uplugin: Plugins\/Studio belongs to a linked repo mounted there \(see teamsync\.yaml\)/,
      );

      await put(scene.alice, "Plugins/Other/x.uplugin", "{}");
      await stageAndSubmit(scene.alice, ["Plugins/Other"]);
    });
  });
});
