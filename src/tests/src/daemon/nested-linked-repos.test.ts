/**
 * Team Sync nested linked repos, end to end: a game repo's teamsync.yaml
 * mounts a plugins repo at `Plugins/Studio`, and syncing a game workspace
 * creates the plugins workspace in that folder (when the link is enabled),
 * brings it to the pin, and keeps its files out of the game's pending
 * changes while reporting its own (src/core/daemon/src/util/team-sync/
 * linked-repos.ts, docs/linked-repos-plan.md).
 *
 * Driven through the daemon's endpoints against the real app routers, with
 * only the native addon faked (src/harness/stack.ts). The repo config is
 * answered by the harness, keyed by repo.
 */
import type { TeamSyncConfig, TeamSyncLinkedRepo } from "@checkpointvcs/common";
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
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
import { makeOrg, makeRepo, makeUser } from "../harness/fixtures";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import {
  getWorkspaceConfig,
  getWorkspaceState,
} from "../../../core/daemon/src/util/util.js";
import type { LinkSyncResult } from "../../../core/daemon/src/util/team-sync/linked-repos.js";
import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import {
  daemonApi,
  detachSeat,
  headOf,
  makeSeat,
  overrides,
  pendingChanges,
  put,
  read,
  resetStack,
  seatIds,
  setTeamSync,
  stageAndSubmit,
  syncLatest,
  type Seat,
} from "../harness/stack";

const MOUNT = "Plugins/Studio";

interface Scene {
  /** Alice authors the plugins; Bob plays the game. */
  alicePlugins: Seat;
  bobGame: Seat;
  gameRepoId: string;
  pluginsRepoId: string;
  pluginsV1: number;
  pluginsV2: number;
}

/** The nested link each game repo's config declares (by repo id). */
const links = new Map<string, Partial<TeamSyncLinkedRepo> & { changelist: number }>();

function configFor(repoId: string): TeamSyncConfig | null {
  const link = links.get(repoId);
  if (!link) return null;
  return {
    version: 1,
    syncCategories: [],
    presets: [],
    linkedRepos: [
      {
        repo: "StudioPlugins",
        branch: "main",
        path: MOUNT,
        enabledByDefault: true,
        ...link,
      },
    ],
    buildSteps: [],
    artifacts: [],
    contentBadges: [],
    tools: [],
    forceClean: { changelists: [] },
  };
}

type PullResult = { linkedRepos?: LinkSyncResult[] };

const only = (result: unknown) => {
  const all = (result as PullResult).linkedRepos ?? [];
  expect(all).toHaveLength(1);
  return all[0]!;
};

/** A pull's job ends a moment before its workspace stops counting as busy. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe("Team Sync nested linked repos", { timeout: 120_000 }, () => {
  let testDb: TestDb;
  let s: Scene;

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
    links.clear();
    overrides.teamSyncConfig = async (input) => ({
      config: configFor((input as { repoId: string }).repoId),
      sourceChangelistNumber: 1,
      errors: null,
    });

    const db = testDb.client;
    const alice = await makeUser(db, { name: "alice" });
    const bob = await makeUser(db, { name: "bob" });
    const org = await makeOrg(db, {
      ownerId: alice.id,
      ownerRole: "ADMIN",
      defaultRepoAccess: "WRITE",
    });
    await db.orgUser.create({
      data: { orgId: org.id, userId: bob.id, role: "MEMBER" },
    });
    const game = await makeRepo(db, org.id, alice.id, { name: "Game" });
    const plugins = await makeRepo(db, org.id, alice.id, {
      name: "StudioPlugins",
    });

    const alicePlugins = await makeSeat(db, {
      name: "alice-plugins",
      user: alice,
      repoId: plugins.id,
      orgId: org.id,
    });
    const aliceGame = await makeSeat(db, {
      name: "alice-game",
      user: alice,
      repoId: game.id,
      orgId: org.id,
    });
    const bobGame = await makeSeat(db, {
      name: "bob-game",
      user: bob,
      repoId: game.id,
      orgId: org.id,
    });

    await put(alicePlugins, "Studio.uplugin", "v1\n");
    await stageAndSubmit(alicePlugins, ["Studio.uplugin"]);
    const pluginsV1 = await headOf(db, plugins.id, "main");
    await put(alicePlugins, "Studio.uplugin", "v2\n");
    await stageAndSubmit(alicePlugins, ["Studio.uplugin"]);
    const pluginsV2 = await headOf(db, plugins.id, "main");

    await put(aliceGame, "Source/game.cpp", "int main() {}\n");
    await stageAndSubmit(aliceGame, ["Source"]);
    await detachSeat(aliceGame);
    await rm(aliceGame.root, { recursive: true, force: true });

    await setTeamSync(bobGame, {});
    s = {
      alicePlugins,
      bobGame,
      gameRepoId: game.id,
      pluginsRepoId: plugins.id,
      pluginsV1,
      pluginsV2,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const manager = DaemonManager.Get();
    manager.ephemeral = false;
    // Children this test created live inside the seats' folders.
    for (const list of [...manager.workspaces.values()]) {
      for (const w of [...list]) manager.unlinkWorkspace(w.id, w.daemonId);
    }
    closeAllStateStores();
    for (const seat of [s.alicePlugins, s.bobGame]) {
      await rm(seat.root, { recursive: true, force: true });
    }
  });

  const childFolder = () => `${s.bobGame.root}/${MOUNT}`;
  const childFile = (name = "Studio.uplugin") =>
    path.join(childFolder(), name);
  const child = () =>
    DaemonManager.Get().linkedSyncDeps().findWorkspaceAt(childFolder());
  const workspacesOfPlugins = () =>
    [...DaemonManager.Get().workspaces.values()]
      .flat()
      .filter((w) => w.repoId === s.pluginsRepoId);

  it("creates the child workspace in its folder on the first sync, and syncs it to the pin", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });

    const result = only(await syncLatest(s.bobGame));
    expect(result).toMatchObject({
      status: "synced",
      created: true,
      path: MOUNT,
      pin: s.pluginsV1,
      fromChangelist: 0,
    });
    expect(await readFile(childFile(), "utf8")).toBe("v1\n");
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");

    const created = await child();
    expect(created).toMatchObject({
      repoId: s.pluginsRepoId,
      domainBranchName: "main",
    });
    expect(result.workspaceId).toBe(created!.id);
    const settings = (await getWorkspaceConfig(s.bobGame.root))?.teamSync;
    expect(settings?.linkedWorkspaces).toEqual({
      StudioPlugins: { mode: "follow-pin", workspaceId: created!.id },
    });

    // The game sees the folder as the child's.
    const pending = Object.keys(await pendingChanges(s.bobGame));
    expect(pending.filter((p) => p.startsWith("Plugins"))).toEqual([]);
    const state = await getWorkspaceState(s.bobGame.root, "sqlite");
    expect(state.teamSync?.mountPaths).toEqual([MOUNT]);
  });

  it("follows the pin, and uses the workspace already in the folder rather than making another", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });
    await syncLatest(s.bobGame);
    await settle();
    const first = (await child())!.id;

    links.set(s.gameRepoId, { changelist: s.pluginsV2 });
    const moved = only(await syncLatest(s.bobGame));
    expect(moved).toMatchObject({ status: "synced", workspaceId: first });
    expect(moved.created).toBeUndefined();
    expect(await readFile(childFile(), "utf8")).toBe("v2\n");
    await settle();

    expect(only(await syncLatest(s.bobGame)).status).toBe("up-to-date");
    expect(workspacesOfPlugins().map((w) => w.id)).toEqual([
      s.alicePlugins.workspace.id,
      first,
    ]);
  });

  it("finds the child by its folder even when workspace.json names another workspace", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });
    await syncLatest(s.bobGame);
    await settle();
    await setTeamSync(s.bobGame, {
      linkedWorkspaces: {
        StudioPlugins: {
          mode: "follow-pin",
          workspaceId: s.alicePlugins.workspace.id,
        },
      },
    });
    expect(only(await syncLatest(s.bobGame))).toMatchObject({
      status: "up-to-date",
      workspaceId: (await child())!.id,
    });
  });

  it("leaves the folder empty for a link off by default, until the workspace turns it on", async () => {
    links.set(s.gameRepoId, {
      changelist: s.pluginsV1,
      enabledByDefault: false,
    });
    expect(only(await syncLatest(s.bobGame))).toMatchObject({
      status: "ignored",
      source: "default",
    });
    expect(existsSync(childFolder())).toBe(false);

    await setTeamSync(s.bobGame, {
      linkedWorkspaces: { StudioPlugins: { mode: "follow-pin" } },
    });
    expect(only(await syncLatest(s.bobGame))).toMatchObject({
      status: "synced",
      created: true,
    });
    expect(await readFile(childFile(), "utf8")).toBe("v1\n");
  });

  it("does not create the child in manual mode", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });
    await setTeamSync(s.bobGame, {
      linkedWorkspaces: { StudioPlugins: { mode: "manual" } },
    });
    expect(only(await syncLatest(s.bobGame)).status).toBe("not-created");
    expect(existsSync(childFolder())).toBe(false);
  });

  it("reports a child it could not create, and still syncs the parent", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1, repo: "NoSuchRepo" });
    const result = only(await syncLatest(s.bobGame));
    expect(result.status).toBe("create-failed");
    expect(result.error).toMatch(/No repo named NoSuchRepo/);
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
    expect(await child()).toBeUndefined();
  });

  it("reports, and leaves alone, a workspace in the folder this daemon doesn't know", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });
    await mkdir(`${childFolder()}/.checkpoint`, { recursive: true });
    await writeFile(`${childFolder()}/.checkpoint/workspace.json`, "{}");

    expect(only(await syncLatest(s.bobGame)).status).toBe("missing-workspace");
    expect(await child()).toBeUndefined();
    expect(existsSync(childFile())).toBe(false);
  });

  it("asks before moving a child with local changes, like any linked workspace", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });
    await syncLatest(s.bobGame);
    await settle();
    await writeFile(childFile("Notes.txt"), "bob's notes\n");

    links.set(s.gameRepoId, { changelist: s.pluginsV2 });
    await expect(syncLatest(s.bobGame)).rejects.toThrow(/has local changes/);
    await syncLatest(s.bobGame, { confirmLinks: ["StudioPlugins"] });
    expect(await readFile(childFile(), "utf8")).toBe("v2\n");
    expect(await readFile(childFile("Notes.txt"), "utf8")).toBe(
      "bob's notes\n",
    );
  });

  it("reports a nested link before its first sync, without creating anything", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });
    const daemon = await daemonApi();
    const report = await daemon.workspaces.teamSync.getLinkedRepos({
      ...seatIds(s.bobGame),
      changelistNumber: 1,
    });
    expect(report.links[0]).toMatchObject({
      repo: "StudioPlugins",
      status: "not-created",
      path: MOUNT,
    });
    expect(existsSync(childFolder())).toBe(false);
  });

  it("tells the parent how many pending changes the child has", async () => {
    links.set(s.gameRepoId, { changelist: s.pluginsV1 });
    await syncLatest(s.bobGame);
    await settle();
    const daemon = await daemonApi();
    const summary = () =>
      daemon.workspaces.pending.nestedWorkspaces(seatIds(s.bobGame));

    expect(await summary()).toEqual([
      {
        path: MOUNT,
        workspaceId: (await child())!.id,
        workspaceName: (await child())!.name,
        pendingCount: 0,
      },
    ]);

    await writeFile(childFile("New.uasset"), "x");
    await writeFile(childFile(), "edited\n");
    expect((await summary())[0]?.pendingCount).toBe(2);
    // And none of it shows as the parent's.
    const pending = Object.keys(await pendingChanges(s.bobGame));
    expect(pending.filter((p) => p.startsWith("Plugins"))).toEqual([]);
  });

  describe("from a daemonless CLI (a build agent's pull)", () => {
    /**
     * What `checkpoint pull` with CHECKPOINT_DAEMONLESS sees: an ephemeral
     * daemon that has registered only the workspace it runs for.
     */
    const goEphemeral = () => {
      const manager = DaemonManager.Get();
      manager.ephemeral = true;
      for (const w of workspacesOfPlugins()) {
        if (w.id !== s.alicePlugins.workspace.id) {
          manager.unlinkWorkspace(w.id, w.daemonId);
        }
      }
    };

    it("creates the child and syncs it to the pin", async () => {
      links.set(s.gameRepoId, { changelist: s.pluginsV1 });
      goEphemeral();
      expect(only(await syncLatest(s.bobGame))).toMatchObject({
        status: "synced",
        created: true,
      });
      expect(await readFile(childFile(), "utf8")).toBe("v1\n");
    });

    it("picks up a child already on disk and follows the pin, instead of calling it missing", async () => {
      links.set(s.gameRepoId, { changelist: s.pluginsV1 });
      await syncLatest(s.bobGame);
      await settle();
      const first = (await child())!.id;

      goEphemeral();
      expect(workspacesOfPlugins().map((w) => w.id)).not.toContain(first);
      links.set(s.gameRepoId, { changelist: s.pluginsV2 });
      expect(only(await syncLatest(s.bobGame))).toMatchObject({
        status: "synced",
        workspaceId: first,
      });
      expect(await readFile(childFile(), "utf8")).toBe("v2\n");
      expect(workspacesOfPlugins().map((w) => w.id)).toContain(first);
    });

    it("counts a child's pending changes for `checkpoint status`", async () => {
      links.set(s.gameRepoId, { changelist: s.pluginsV1 });
      await syncLatest(s.bobGame);
      await settle();
      const first = (await child())!.id;
      await writeFile(childFile("New.uasset"), "x");

      goEphemeral();
      const daemon = await daemonApi();
      expect(
        await daemon.workspaces.pending.nestedWorkspaces(seatIds(s.bobGame)),
      ).toMatchObject([{ path: MOUNT, workspaceId: first, pendingCount: 1 }]);
    });

    it("still leaves alone a folder whose workspace.json is damaged", async () => {
      links.set(s.gameRepoId, { changelist: s.pluginsV1 });
      await mkdir(`${childFolder()}/.checkpoint`, { recursive: true });
      await writeFile(`${childFolder()}/.checkpoint/workspace.json`, "{}");
      goEphemeral();

      expect(only(await syncLatest(s.bobGame)).status).toBe(
        "missing-workspace",
      );
      expect(existsSync(childFile())).toBe(false);
    });
  });

  it("lists an ignored link's folder with no workspace or count", async () => {
    links.set(s.gameRepoId, {
      changelist: s.pluginsV1,
      enabledByDefault: false,
    });
    await syncLatest(s.bobGame);
    const daemon = await daemonApi();
    expect(
      await daemon.workspaces.pending.nestedWorkspaces(seatIds(s.bobGame)),
    ).toEqual([
      { path: MOUNT, workspaceId: null, workspaceName: null, pendingCount: null },
    ]);
  });
});
