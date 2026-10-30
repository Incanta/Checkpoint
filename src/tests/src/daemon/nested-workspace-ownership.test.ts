/**
 * Folders inside a workspace that belong to another workspace: a Team Sync
 * nested linked repo's mount path (from the repo config at the synced
 * changelist), or any folder holding its own `.checkpoint`. The parent never
 * lists, stages, submits, or cleans them (plans/linked-repos-plan.md, "Nested
 * link groundwork").
 *
 * Driven through the daemon's endpoints against the real app routers, with
 * only the native addon faked (src/harness/stack.ts).
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
import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import { JobManager } from "../../../core/daemon/src/job-manager.js";
import {
  cleanExecute,
  cleanPreview,
  daemonApi,
  exists,
  makeScene,
  overrides,
  pendingChanges,
  put,
  read,
  resetStack,
  seatIds,
  setTeamSync,
  stage,
  stageAndSubmit,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

/** The mount paths the repo config declares; empty means no nested links. */
let mounts: string[] = [];

function config(): TeamSyncConfig {
  return {
    version: 1,
    syncCategories: [],
    presets: [],
    linkedRepos: mounts.map((path, i) => ({
      repo: `Child${i}`,
      branch: "main",
      changelist: 1,
      path,
      enabledByDefault: true,
    })),
    buildSteps: [],
    artifacts: [],
    contentBadges: [],
    tools: [],
    forceClean: { changelists: [] },
  };
}

/** Pending paths, so a test can say nothing under a folder shows. */
const pendingPaths = async (scene: Scene) =>
  Object.keys(await pendingChanges(scene.alice));

const under = (paths: string[], folder: string) =>
  paths.filter(
    (p) =>
      p.toLowerCase() === folder.toLowerCase() ||
      p.toLowerCase().startsWith(`${folder.toLowerCase()}/`),
  );

describe("folders owned by nested workspaces", { timeout: 120_000 }, () => {
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
    mounts = [];
    overrides.teamSyncConfig = async () => ({
      config: config(),
      sourceChangelistNumber: 1,
      errors: null,
    });
    scene = await makeScene(testDb.client);
    await setTeamSync(scene.alice, {});
    await put(scene.alice, "Source/game.cpp", "int main() {}\n");
    await stageAndSubmit(scene.alice, ["Source"]);
  });

  afterEach(async () => {
    closeAllStateStores();
    await tearDownScene(scene);
  });

  it("records the mount paths of the synced changelist and hides what is in them", async () => {
    mounts = ["Plugins/Studio"];
    await put(scene.alice, "Plugins/Studio/Studio.uplugin", "{}");
    await put(scene.alice, "Plugins/Studio/Source/a.cpp", "x");
    await put(scene.alice, "Content/new.uasset", "x");

    await syncLatest(scene.alice);
    const state = await getWorkspaceState(scene.alice.root, "sqlite");
    expect(state.teamSync?.mountPaths).toEqual(["Plugins/Studio"]);

    const paths = await pendingPaths(scene);
    expect(under(paths, "Plugins")).toEqual([]);
    expect(under(paths, "Content").length).toBeGreaterThan(0);
  });

  it("shows the folder's files again once the config stops mounting there", async () => {
    mounts = ["Plugins/Studio"];
    await put(scene.alice, "Plugins/Studio/Studio.uplugin", "{}");
    await syncLatest(scene.alice);
    expect(under(await pendingPaths(scene), "Plugins")).toEqual([]);

    mounts = [];
    await syncLatest(scene.alice);
    const state = await getWorkspaceState(scene.alice.root, "sqlite");
    expect(state.teamSync?.mountPaths).toBeUndefined();
    expect(under(await pendingPaths(scene), "Plugins").length).toBeGreaterThan(
      0,
    );
  });

  it("matches the mount path in any case", async () => {
    mounts = ["plugins/studio"];
    await put(scene.alice, "Plugins/Studio/Studio.uplugin", "{}");
    await syncLatest(scene.alice);
    expect(under(await pendingPaths(scene), "Plugins")).toEqual([]);
  });

  it("refuses to stage files in a mount path", async () => {
    mounts = ["Plugins/Studio"];
    await put(scene.alice, "Plugins/Studio/Studio.uplugin", "{}");
    await syncLatest(scene.alice);

    await expect(
      stage(scene.alice, ["Plugins/Studio/Studio.uplugin"]),
    ).rejects.toThrow(/in another workspace nested here \(Plugins\/Studio\)/);
    await expect(stage(scene.alice, ["Plugins/Studio"])).rejects.toThrow(
      /nested here/,
    );
  });

  it("treats a folder holding its own workspace as that workspace's, as soon as it appears", async () => {
    await put(scene.alice, "Tools/Child/notes.txt", "x");
    expect(under(await pendingPaths(scene), "Tools").length).toBeGreaterThan(0);

    await put(scene.alice, "Tools/Child/.checkpoint/workspace.json", "{}");
    const manager = DaemonManager.Get();
    await manager.handleWatchEvent(
      scene.alice.workspace as never,
      "rename",
      "Tools/Child/.checkpoint/workspace.json",
    );
    expect(under(await pendingPaths(scene), "Tools")).toEqual([]);
    expect(
      manager.nestedOwnerOf(scene.alice.workspace.id, "tools/child/notes.txt"),
    ).toBe("Tools/Child");

    // And stops when the workspace goes.
    await import("node:fs/promises").then((fs) =>
      fs.rm(`${scene.alice.root}/Tools/Child/.checkpoint`, {
        recursive: true,
        force: true,
      }),
    );
    await manager.handleWatchEvent(
      scene.alice.workspace as never,
      "rename",
      "Tools/Child/.checkpoint",
    );
    expect(under(await pendingPaths(scene), "Tools").length).toBeGreaterThan(0);
  });

  it("ignores watcher events inside a nested workspace, its ignore files included", async () => {
    mounts = ["Plugins/Studio"];
    await syncLatest(scene.alice);
    const manager = DaemonManager.Get();
    const scan = vi.spyOn(manager, "scanIgnoreFiles");
    await manager.handleWatchEvent(
      scene.alice.workspace as never,
      "change",
      "Plugins/Studio/.chkignore",
    );
    await manager.handleWatchEvent(
      scene.alice.workspace as never,
      "change",
      "Plugins/Studio/.checkpoint/state.db",
    );
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  it("checkpoint clean removes an untracked folder around a nested workspace, but not the workspace", async () => {
    mounts = ["Plugins/Studio"];
    await put(scene.alice, "Plugins/stray.txt", "x");
    await put(scene.alice, "Plugins/Other/x.uplugin", "x");
    await put(scene.alice, "Plugins/Studio/Studio.uplugin", "keep");
    await put(scene.alice, "Plugins/Studio/Source/a.cpp", "keep");
    await syncLatest(scene.alice);

    const daemon = await daemonApi();
    const { jobId } = await daemon.workspaces.sync.clean({
      ...seatIds(scene.alice),
      noProgress: true,
    });
    const jobs = JobManager.Get();
    for (let i = 0; i < 6000; i++) {
      const status = jobs.getJob(jobId)?.status;
      if (status === "completed" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(jobs.getJob(jobId)?.status).toBe("completed");

    expect(exists(scene.alice, "Plugins/stray.txt")).toBe(false);
    expect(exists(scene.alice, "Plugins/Other/x.uplugin")).toBe(false);
    expect(await read(scene.alice, "Plugins/Studio/Studio.uplugin")).toBe(
      "keep",
    );
    expect(await read(scene.alice, "Plugins/Studio/Source/a.cpp")).toBe(
      "keep",
    );
  });

  it("Team Sync's Clean Workspace never offers or cleans a nested workspace's files", async () => {
    mounts = ["Plugins/Studio"];
    await put(scene.alice, "Plugins/stray.txt", "x");
    await put(scene.alice, "Plugins/Studio/Intermediate/a.obj", "keep");
    await put(scene.alice, "Tools/Child/.checkpoint/workspace.json", "{}");
    await put(scene.alice, "Tools/Child/Saved/log.txt", "keep");
    await syncLatest(scene.alice);

    const offered = (await cleanPreview(scene.alice)).map((c) => c.path);
    expect(offered).toContain("Plugins/stray.txt");
    expect(under(offered, "Plugins/Studio")).toEqual([]);
    expect(under(offered, "Tools/Child")).toEqual([]);

    const result = await cleanExecute(scene.alice, [
      "Plugins/Studio/Intermediate/a.obj",
      "Tools/Child/Saved/log.txt",
      "Plugins/stray.txt",
    ]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual([
      "Plugins/Studio/Intermediate/a.obj",
      "Tools/Child/Saved/log.txt",
    ]);
    expect(result.skipped.map((s) => s.reason).join("\n")).toMatch(
      /nested linked repo owns[\s\S]*another workspace/,
    );
    expect(exists(scene.alice, "Plugins/Studio/Intermediate/a.obj")).toBe(true);
    expect(exists(scene.alice, "Tools/Child/Saved/log.txt")).toBe(true);
    expect(exists(scene.alice, "Plugins/stray.txt")).toBe(false);
  });
});
