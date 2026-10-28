/**
 * Team Sync linked repos, end to end: a game repo's teamsync.yaml pins an
 * engine repo, and syncing a game workspace first brings the chosen engine
 * workspace to the pin (src/core/daemon/src/util/team-sync/linked-repos.ts,
 * docs/linked-repos-plan.md).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts). The repo config
 * is answered by the harness, keyed by repo, so a test can move a pin.
 */
import type { TeamSyncConfig, TeamSyncPreset } from "@checkpointvcs/common";
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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { getWorkspaceState } from "../../../core/daemon/src/util/util.js";
import type { LinkSyncResult } from "../../../core/daemon/src/util/team-sync/linked-repos.js";
import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import {
  daemonApi,
  detachSeat,
  exists,
  headOf,
  makeSeat,
  overrides,
  put,
  read,
  resetStack,
  seatIds,
  setTeamSync,
  stageAndSubmit,
  syncLatest,
  type Seat,
} from "../harness/stack";

interface LinkScene {
  /** Alice authors both repos. */
  aliceGame: Seat;
  aliceEngine: Seat;
  aliceGame2: Seat;
  /** Bob plays two games on one engine workspace. */
  bobGame: Seat;
  bobGame2: Seat;
  bobEngine: Seat;
  gameRepoId: string;
  game2RepoId: string;
  engineRepoId: string;
  /** Engine changelists: v1 and v2 of Engine/Build/Build.version. */
  engineV1: number;
  engineV2: number;
}

/** Engine pin per game repo id; the harness serves configs from it. */
const pins = new Map<string, number>();
/** Presets per game repo id. */
const presets = new Map<string, TeamSyncPreset[]>();

function configFor(repoId: string): TeamSyncConfig | null {
  const pin = pins.get(repoId);
  if (pin === undefined) return null;
  return {
    version: 1,
    syncCategories: [],
    presets: presets.get(repoId) ?? [],
    linkedRepos: [
      { repo: "UE5", branch: "main", changelist: pin, enabledByDefault: true },
    ],
    buildSteps: [],
    artifacts: [],
    contentBadges: [],
    tools: [],
    forceClean: { changelists: [] },
  };
}

type PullResult = { linkedRepos?: LinkSyncResult[]; stalePins?: string[] };

/**
 * A pull's job completes a moment before the daemon stops treating its
 * workspace as busy (the watcher grace period), and a linked workspace that
 * is busy stops the parent's sync. Waits that moment out.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe("Team Sync linked repos", { timeout: 120_000 }, () => {
  let testDb: TestDb;
  let s: LinkScene;

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
    pins.clear();
    presets.clear();
    overrides.teamSyncConfig = async (input) => {
      const { repoId } = input as { repoId: string };
      return {
        config: configFor(repoId),
        sourceChangelistNumber: 1,
        errors: null,
      };
    };

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
    const game2 = await makeRepo(db, org.id, alice.id, { name: "Game2" });
    const engine = await makeRepo(db, org.id, alice.id, { name: "UE5" });
    const seat = (name: string, user: typeof alice, repoId: string) =>
      makeSeat(db, { name, user, repoId, orgId: org.id });

    const aliceGame = await seat("alice-game", alice, game.id);
    const aliceGame2 = await seat("alice-game2", alice, game2.id);
    const aliceEngine = await seat("alice-engine", alice, engine.id);
    const bobGame = await seat("bob-game", bob, game.id);
    const bobGame2 = await seat("bob-game2", bob, game2.id);
    const bobEngine = await seat("bob-engine", bob, engine.id);

    await put(aliceEngine, "Engine/Build/Build.version", "v1\n");
    await stageAndSubmit(aliceEngine, ["Engine"]);
    const engineV1 = await headOf(db, engine.id, "main");
    await put(aliceEngine, "Engine/Build/Build.version", "v2\n");
    await stageAndSubmit(aliceEngine, ["Engine/Build/Build.version"]);
    const engineV2 = await headOf(db, engine.id, "main");

    await put(aliceGame, "Source/game.cpp", "int main() {}\n");
    await stageAndSubmit(aliceGame, ["Source"]);
    await put(aliceGame2, "Source/game2.cpp", "int main() {}\n");
    await stageAndSubmit(aliceGame2, ["Source"]);

    s = {
      aliceGame,
      aliceEngine,
      aliceGame2,
      bobGame,
      bobGame2,
      bobEngine,
      gameRepoId: game.id,
      game2RepoId: game2.id,
      engineRepoId: engine.id,
      engineV1,
      engineV2,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeAllStateStores();
    for (const seat of Object.values(s).filter(
      (v): v is Seat => typeof v === "object" && v !== null && "root" in v,
    )) {
      await detachSeat(seat);
      await rm(seat.root, { recursive: true, force: true });
    }
  });

  const link = (
    parent: Seat,
    mode: "follow-pin" | "manual" | "ignore",
    linked: Seat | null = s.bobEngine,
  ) =>
    setTeamSync(parent, {
      linkedWorkspaces: {
        UE5: { mode, ...(linked && { workspaceId: linked.workspace.id }) },
      },
    });

  const clOf = async (seat: Seat) =>
    (await getWorkspaceState(seat.root, "sqlite")).changelistNumber;

  const only = (result: unknown) => {
    const links = (result as PullResult).linkedRepos ?? [];
    expect(links).toHaveLength(1);
    return links[0]!;
  };

  it("syncs the linked workspace to the pin before the parent, and follows the pin when it moves", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "follow-pin");

    const first = only(await syncLatest(s.bobGame));
    expect(first).toMatchObject({ status: "synced", pin: s.engineV1, fromChangelist: 0 });
    expect(await read(s.bobEngine, "Engine/Build/Build.version")).toBe("v1\n");
    expect(await clOf(s.bobEngine)).toBe(s.engineV1);
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");

    const engineState = await getWorkspaceState(s.bobEngine.root, "sqlite");
    expect(engineState.teamSync?.linkHolder).toMatchObject({
      workspaceId: s.bobGame.workspace.id,
      changelist: s.engineV1,
    });
    const gameState = await getWorkspaceState(s.bobGame.root, "sqlite");
    expect(gameState.teamSync?.linkedPins?.UE5).toMatchObject({
      changelist: s.engineV1,
      workspaceId: s.bobEngine.workspace.id,
    });

    pins.set(s.gameRepoId, s.engineV2);
    expect(only(await syncLatest(s.bobGame)).status).toBe("synced");
    expect(await read(s.bobEngine, "Engine/Build/Build.version")).toBe("v2\n");

    // Nothing left to do.
    expect(only(await syncLatest(s.bobGame)).status).toBe("up-to-date");
  });

  it("brings a link up to its pin when the parent is already current", async () => {
    // What `checkpoint pull` relies on: it asks for link statuses when the
    // workspace is up to date, and pulls anyway if a link is behind.
    pins.set(s.gameRepoId, s.engineV1);
    await syncLatest(s.bobGame);
    const gameCl = await clOf(s.bobGame);
    await link(s.bobGame, "follow-pin");

    const daemon = await daemonApi();
    const report = await daemon.workspaces.teamSync.getLinkedRepos(
      seatIds(s.bobGame),
    );
    expect(report.links[0]).toMatchObject({ status: "out-of-date", mode: "follow-pin" });

    expect(only(await syncLatest(s.bobGame)).status).toBe("synced");
    expect(await clOf(s.bobEngine)).toBe(s.engineV1);
    expect(await clOf(s.bobGame)).toBe(gameCl);
  });

  it("syncs the parent and reports a link with no workspace chosen as not set up", async () => {
    pins.set(s.gameRepoId, s.engineV1);

    expect(only(await syncLatest(s.bobGame))).toMatchObject({
      status: "not-set-up",
      source: "default",
    });
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
    expect(await clOf(s.bobEngine)).toBe(0);
    expect(exists(s.bobEngine, "Engine/Build/Build.version")).toBe(false);
  });

  it("leaves an ignored link alone, whether ignored by the workspace or its preset", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "ignore", null);
    expect(only(await syncLatest(s.bobGame))).toMatchObject({
      status: "ignored",
      source: "workspace",
    });

    presets.set(s.gameRepoId, [
      {
        name: "Artist",
        default: true,
        locked: false,
        categories: {},
        buildSteps: {},
        linkedRepos: { UE5: "ignore" },
      },
    ]);
    await setTeamSync(s.bobGame, {});
    expect(only(await syncLatest(s.bobGame))).toMatchObject({
      status: "ignored",
      source: "preset",
    });
    expect(await clOf(s.bobEngine)).toBe(0);
  });

  it("reports but never moves a linked workspace in manual mode", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "manual");

    expect(only(await syncLatest(s.bobGame))).toMatchObject({
      status: "out-of-date",
      fromChangelist: 0,
    });
    expect(await clOf(s.bobEngine)).toBe(0);
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
  });

  it("stops the parent's sync while the linked workspace is busy, and syncs once it is free", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "follow-pin");
    const manager = DaemonManager.Get();

    manager.beginVcsOperation(s.bobEngine.workspace.id);
    try {
      await expect(syncLatest(s.bobGame)).rejects.toThrow(
        /linked repo UE5 .* is busy with another operation/,
      );
      expect(await clOf(s.bobGame)).toBe(0);
    } finally {
      await manager.endVcsOperation(s.bobEngine.workspace.id);
    }

    expect(only(await syncLatest(s.bobGame)).status).toBe("synced");
  });

  it("does not care that a linked workspace already at the pin is busy", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "follow-pin");
    await syncLatest(s.bobGame);
    await settle();
    const manager = DaemonManager.Get();

    manager.beginVcsOperation(s.bobEngine.workspace.id);
    try {
      expect(only(await syncLatest(s.bobGame)).status).toBe("up-to-date");
    } finally {
      await manager.endVcsOperation(s.bobEngine.workspace.id);
    }
  });

  it("will not move an engine back from ahead of the pin without confirmation, and leaves the parent where it was", async () => {
    await syncLatest(s.bobEngine);
    await settle();
    expect(await clOf(s.bobEngine)).toBe(s.engineV2);
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "follow-pin");

    await expect(syncLatest(s.bobGame)).rejects.toThrow(/needs confirmation.*ahead of the pin/s);
    expect(await clOf(s.bobGame)).toBe(0);
    expect(exists(s.bobGame, "Source/game.cpp")).toBe(false);
    expect(await clOf(s.bobEngine)).toBe(s.engineV2);

    expect(only(await syncLatest(s.bobGame, { confirmLinks: ["ue5"] })).status).toBe(
      "synced",
    );
    expect(await clOf(s.bobEngine)).toBe(s.engineV1);
    expect(await read(s.bobEngine, "Engine/Build/Build.version")).toBe("v1\n");
  });

  it("hands the links that need confirmation to the client in the failed job", async () => {
    pins.set(s.gameRepoId, s.engineV2);
    await link(s.bobGame, "follow-pin");
    await put(s.bobEngine, "Engine/Source/patch.cpp", "bob's engine patch\n");

    const failure = await syncLatest(s.bobGame).then(
      () => null,
      (err: { jobResult?: unknown }) => err,
    );
    const confirmations = (
      failure?.jobResult as { linkConfirmations?: LinkSyncResult[] } | null
    )?.linkConfirmations;
    expect(confirmations).toHaveLength(1);
    expect(confirmations?.[0]).toMatchObject({
      repo: "UE5",
      status: "needs-confirmation",
      reasons: ["local-changes"],
      pin: s.engineV2,
      fromChangelist: 0,
      workspaceName: s.bobEngine.workspace.name,
    });
  });

  it("puts no confirmation detail on a pull that failed for another reason", async () => {
    pins.set(s.gameRepoId, 9999);
    await link(s.bobGame, "follow-pin");
    const failure = await syncLatest(s.bobGame).then(
      () => null,
      (err: { jobResult?: unknown }) => err,
    );
    expect(failure).not.toBeNull();
    expect(failure?.jobResult ?? null).toBeNull();
  });

  it("asks before moving an engine with local changes, and keeps them when confirmed", async () => {
    pins.set(s.gameRepoId, s.engineV2);
    await link(s.bobGame, "follow-pin");
    await put(s.bobEngine, "Engine/Source/patch.cpp", "bob's engine patch\n");

    await expect(syncLatest(s.bobGame)).rejects.toThrow(/has local changes/);
    expect(await clOf(s.bobEngine)).toBe(0);

    await syncLatest(s.bobGame, { confirmLinks: ["UE5"] });
    expect(await clOf(s.bobEngine)).toBe(s.engineV2);
    expect(await read(s.bobEngine, "Engine/Source/patch.cpp")).toBe(
      "bob's engine patch\n",
    );
  });

  it("asks before moving an engine another game moved to a different pin", async () => {
    pins.set(s.game2RepoId, s.engineV1);
    pins.set(s.gameRepoId, s.engineV2);
    await link(s.bobGame2, "follow-pin");
    await link(s.bobGame, "follow-pin");

    expect(only(await syncLatest(s.bobGame2)).status).toBe("synced");
    expect(await clOf(s.bobEngine)).toBe(s.engineV1);

    await expect(syncLatest(s.bobGame)).rejects.toThrow(
      /another workspace moved it.*bob-game2.*changelist/s,
    );
    expect(await clOf(s.bobEngine)).toBe(s.engineV1);

    await syncLatest(s.bobGame, { confirmLinks: ["UE5"] });
    expect(await clOf(s.bobEngine)).toBe(s.engineV2);
    const holder = (await getWorkspaceState(s.bobEngine.root, "sqlite")).teamSync
      ?.linkHolder;
    expect(holder?.workspaceId).toBe(s.bobGame.workspace.id);

    // Game2 now finds the engine held by Game at another pin, and asks.
    await expect(syncLatest(s.bobGame2)).rejects.toThrow(/needs confirmation/);
  });

  it("does not ask when the other game holds the engine at the same pin", async () => {
    pins.set(s.game2RepoId, s.engineV1);
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame2, "follow-pin");
    await link(s.bobGame, "follow-pin");

    await syncLatest(s.bobGame2);
    expect(only(await syncLatest(s.bobGame)).status).toBe("up-to-date");
  });

  it("does not ask about a holder that is no longer registered", async () => {
    pins.set(s.game2RepoId, s.engineV1);
    pins.set(s.gameRepoId, s.engineV2);
    await link(s.bobGame2, "follow-pin");
    await link(s.bobGame, "follow-pin");
    await syncLatest(s.bobGame2);

    await detachSeat(s.bobGame2);
    expect(only(await syncLatest(s.bobGame)).status).toBe("synced");
  });

  it("reports a linked workspace of the wrong repo and syncs the parent anyway", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "follow-pin", s.bobGame2);

    expect(only(await syncLatest(s.bobGame)).status).toBe("wrong-repo");
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
    expect(await clOf(s.bobGame2)).toBe(0);
  });

  it("reports a linked workspace that is not registered", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await setTeamSync(s.bobGame, {
      linkedWorkspaces: { UE5: { mode: "follow-pin", workspaceId: "gone" } },
    });
    expect(only(await syncLatest(s.bobGame)).status).toBe("missing-workspace");
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
  });

  it("leaves links alone when asked to skip them", async () => {
    pins.set(s.gameRepoId, s.engineV1);
    await link(s.bobGame, "follow-pin");

    const result = (await syncLatest(s.bobGame, { skipLinks: true })) as PullResult;
    expect(result.linkedRepos).toBeUndefined();
    expect(await clOf(s.bobEngine)).toBe(0);
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
  });

  it("syncs like before for a repo with no links", async () => {
    const result = (await syncLatest(s.bobGame)) as PullResult;
    expect(result.linkedRepos).toBeUndefined();
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
  });

  it("syncs the parent when the repo config cannot be read", async () => {
    overrides.teamSyncConfig = async () => {
      throw new Error("API unreachable");
    };
    await link(s.bobGame, "follow-pin");
    const result = (await syncLatest(s.bobGame)) as PullResult;
    expect(result.linkedRepos).toBeUndefined();
    expect(await read(s.bobGame, "Source/game.cpp")).toContain("int main");
  });

  it("does not sync the parent when the linked sync fails", async () => {
    pins.set(s.gameRepoId, 9999);
    await link(s.bobGame, "follow-pin");

    await expect(syncLatest(s.bobGame)).rejects.toThrow(
      /linked repo UE5 .* failed to sync to changelist 9999/,
    );
    expect(await clOf(s.bobGame)).toBe(0);
    expect(exists(s.bobGame, "Source/game.cpp")).toBe(false);
  });

  describe("the settings endpoints", () => {
    it("reports each link without syncing", async () => {
      pins.set(s.gameRepoId, s.engineV1);
      await link(s.bobGame, "follow-pin");
      const daemon = await daemonApi();

      const report = await daemon.workspaces.teamSync.getLinkedRepos({
        ...seatIds(s.bobGame),
        changelistNumber: 1,
      });
      expect(report.links).toHaveLength(1);
      expect(report.links[0]).toMatchObject({
        repo: "UE5",
        status: "out-of-date",
        workspaceId: s.bobEngine.workspace.id,
        fromChangelist: 0,
      });
      expect(await clOf(s.bobEngine)).toBe(0);
    });

    it("lists workspaces of the linked repo as candidates", async () => {
      const daemon = await daemonApi();
      const candidates = await daemon.workspaces.teamSync.listLinkCandidates({
        ...seatIds(s.bobGame),
        repo: "ue5",
        branch: "main",
      });
      expect(candidates.map((c) => c.id).sort()).toEqual(
        [s.aliceEngine.workspace.id, s.bobEngine.workspace.id].sort(),
      );
    });

    it("sets a link to a workspace of the linked repo, and refuses others", async () => {
      await setTeamSync(s.bobGame, {});
      const daemon = await daemonApi();
      const set = (linkedWorkspaceId: string | null, mode = "follow-pin" as const) =>
        daemon.workspaces.teamSync.setLinkedWorkspace({
          ...seatIds(s.bobGame),
          repo: "UE5",
          mode,
          linkedWorkspaceId,
        });

      await expect(set(s.bobGame2.workspace.id)).rejects.toThrow(/holds Game2, not UE5/);
      await expect(set(s.bobGame.workspace.id)).rejects.toThrow(/linked to itself/);
      await expect(set("gone")).rejects.toThrow(/not registered/);

      const saved = await set(s.bobEngine.workspace.id);
      expect(saved.linkedWorkspaces).toEqual({
        UE5: { mode: "follow-pin", workspaceId: s.bobEngine.workspace.id },
      });

      await daemon.workspaces.teamSync.clearLinkedWorkspace({
        ...seatIds(s.bobGame),
        repo: "ue5",
      });
      const settings = await daemon.workspaces.teamSync.getSettings(seatIds(s.bobGame));
      expect(settings.linkedWorkspaces).toEqual({});
    });

    it("reports without scanning the linked workspace for local changes", async () => {
      pins.set(s.gameRepoId, s.engineV1);
      await link(s.bobGame, "follow-pin");
      await put(s.bobEngine, "Engine/Source/patch.cpp", "bob's engine patch\n");
      const manager = DaemonManager.Get();
      const real = manager.linkedSyncDeps.bind(manager);
      const scanned = vi.fn();
      vi.spyOn(manager, "linkedSyncDeps").mockImplementation(() => {
        const deps = real();
        return {
          ...deps,
          hasLocalChanges: async (w) => {
            scanned(w.id);
            return deps.hasLocalChanges(w);
          },
        };
      });

      const daemon = await daemonApi();
      const report = await daemon.workspaces.teamSync.getLinkedRepos(
        seatIds(s.bobGame),
      );
      expect(report.links[0]?.status).toBe("out-of-date");
      expect(scanned).not.toHaveBeenCalled();

      // A sync still checks, and asks.
      await expect(syncLatest(s.bobGame)).rejects.toThrow(/has local changes/);
      expect(scanned).toHaveBeenCalledWith(s.bobEngine.workspace.id);
    });
  });

  describe("creating a linked workspace", () => {
    let folders: string[] = [];
    let created: { id: string; daemonId: string }[] = [];

    beforeEach(async () => {
      folders = [];
      created = [];
      // Real workspaces always have a workspace.json; the seats don't.
      await setTeamSync(s.bobGame, {});
    });

    afterEach(async () => {
      const manager = DaemonManager.Get();
      for (const w of created) manager.unlinkWorkspace(w.id, w.daemonId);
      closeAllStateStores();
      for (const folder of folders) {
        await rm(folder, { recursive: true, force: true });
      }
    });

    const freshFolder = async () => {
      const folder = (
        await mkdtemp(path.join(tmpdir(), "chk-linked-create-"))
      ).replace(/\\/g, "/");
      folders.push(folder);
      return `${folder}/Engines/UE5`;
    };

    const create = async (
      extra: { path?: string; repo?: string; name?: string } = {},
    ) => {
      const daemon = await daemonApi();
      const result = await daemon.workspaces.teamSync.createLinkedWorkspace({
        ...seatIds(s.bobGame),
        repo: "UE5",
        name: "bob-ue5",
        path: extra.path ?? (await freshFolder()),
        ...extra,
      });
      created.push({
        id: result.workspace.id,
        daemonId: s.bobGame.workspace.daemonId,
      });
      return result;
    };

    it("creates an empty workspace of the linked repo on the link's branch, links it, and the next sync fills it", async () => {
      pins.set(s.gameRepoId, s.engineV1);
      const folder = await freshFolder();

      const result = await create({ path: folder });
      expect(result.workspace.localPath).toBe(folder);
      expect(result.settings.linkedWorkspaces).toEqual({
        UE5: { mode: "follow-pin", workspaceId: result.workspace.id },
      });

      const engine = DaemonManager.Get()
        .linkedSyncDeps()
        .findWorkspace(result.workspace.id);
      expect(engine).toMatchObject({
        repoId: s.engineRepoId,
        domainBranchName: "main",
        localPath: folder,
      });

      expect(only(await syncLatest(s.bobGame))).toMatchObject({
        status: "synced",
        workspaceId: result.workspace.id,
        pin: s.engineV1,
      });
      expect(
        await readFile(path.join(folder, "Engine/Build/Build.version"), "utf8"),
      ).toBe("v1\n");
    });

    it("refuses a folder that overlaps a workspace", async () => {
      pins.set(s.gameRepoId, s.engineV1);
      // Inside the game workspace, around it, and the same folder.
      for (const folder of [
        `${s.bobGame.root}/Engine`,
        path.dirname(s.bobGame.root),
        s.bobEngine.root,
      ]) {
        await expect(create({ path: folder })).rejects.toThrow(
          /overlaps workspace/,
        );
      }
    });

    it("refuses a relative folder", async () => {
      pins.set(s.gameRepoId, s.engineV1);
      await expect(create({ path: "Engines/UE5" })).rejects.toThrow(
        /full folder path/,
      );
    });

    it("refuses a repo the config doesn't link", async () => {
      pins.set(s.gameRepoId, s.engineV1);
      await expect(create({ repo: "Game2" })).rejects.toThrow(
        /no link to Game2/,
      );
    });

    it("refuses a link mounted inside the workspace", async () => {
      overrides.teamSyncConfig = async () => ({
        config: {
          ...configFor(s.gameRepoId),
          linkedRepos: [
            {
              repo: "UE5",
              branch: "main",
              changelist: s.engineV1,
              path: "Engine",
              enabledByDefault: true,
            },
          ],
        },
        sourceChangelistNumber: 1,
        errors: null,
      });
      pins.set(s.gameRepoId, s.engineV1);
      await expect(create()).rejects.toThrow(/does not support yet/);
    });
  });
});
