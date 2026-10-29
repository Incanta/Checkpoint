/**
 * Uploading artifacts (build outputs) for a changelist, end to end: every
 * upload names its type (there is no default), the daemon collects files by
 * the repo config's rules for the type (or takes the files named),
 * `.chkignore` does not apply, the upload attaches to that type's set, a
 * collected upload replaces the set, and a workspace applies the types it
 * chose on sync and removes the ones it stops choosing (src/core/daemon/src/
 * api/routers/workspace/artifacts.ts, src/core/daemon/src/util/team-sync/
 * artifacts.ts, src/app/src/server/api/routers/artifact.ts).
 *
 * Driven through the daemon's endpoints against the real app routers, with
 * only the native addon faked (src/harness/stack.ts). The repo config is
 * answered by the harness.
 */
import type { TeamSyncArtifactChannel, TeamSyncConfig } from "@checkpointvcs/common";
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
import { rm } from "node:fs/promises";

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
import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import {
  apiAs,
  daemonApi,
  detachSeat,
  exists,
  fakeAddon,
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
  uploadArtifacts,
  type Seat,
} from "../harness/stack";

let channels: TeamSyncArtifactChannel[] = [];

function config(): TeamSyncConfig {
  return {
    version: 1,
    syncCategories: [],
    presets: [],
    linkedRepos: [],
    buildSteps: [],
    artifacts: channels,
    contentBadges: [],
    tools: [],
    forceClean: { changelists: [] },
  };
}

const EDITOR_TYPE = "editor-win64";
const EDITOR: TeamSyncArtifactChannel = {
  type: EDITOR_TYPE,
  requiredBadges: [],
  include: ["Engine/Binaries/Win64/", "Engine/Plugins/**/Binaries/Win64/"],
  exclude: ["*.pdb"],
};

describe("artifact upload", { timeout: 120_000 }, () => {
  let testDb: TestDb;
  let builder: Seat;
  let teammate: Seat;
  let repoId: string;
  let cl: number;

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
    channels = [EDITOR];
    overrides.teamSyncConfig = async () => ({
      config: config(),
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
    const engine = await makeRepo(db, org.id, alice.id, { name: "UE5" });
    repoId = engine.id;

    builder = await makeSeat(db, {
      name: "builder",
      user: alice,
      repoId,
      orgId: org.id,
    });
    teammate = await makeSeat(db, {
      name: "teammate",
      user: bob,
      repoId,
      orgId: org.id,
    });

    await put(builder, ".chkignore", "Binaries/\n*.pdb\n");
    await put(builder, "Engine/Source/Main.cpp", "int main() {}\n");
    await stageAndSubmit(builder, [".chkignore", "Engine"]);
    cl = await headOf(db, repoId, "main");

    // What a local build leaves behind, all of it ignored by .chkignore.
    await put(builder, "Engine/Binaries/Win64/UnrealEditor.exe", "exe v1");
    await put(builder, "Engine/Binaries/Win64/UnrealEditor.pdb", "pdb");
    await put(builder, "Engine/Binaries/Win64/Old.dll", "old");
    await put(builder, "Engine/Plugins/Foo/Binaries/Win64/Foo.dll", "foo");
    await put(builder, "Engine/Intermediate/Build/obj.o", "obj");
  });

  afterEach(async () => {
    const manager = DaemonManager.Get();
    for (const list of [...manager.workspaces.values()]) {
      for (const w of [...list]) manager.unlinkWorkspace(w.id, w.daemonId);
    }
    closeAllStateStores();
    for (const seat of [builder, teammate]) {
      await detachSeat(seat).catch(() => undefined);
      await rm(seat.root, { recursive: true, force: true });
    }
  });

  const setAt = async (type = EDITOR_TYPE) =>
    (
      await apiAs(builder).artifact.listSets({ repoId, changelistNumber: cl })
    ).find((s) => s.type === type);
  const pathsAt = async () =>
    (await apiAs(builder).artifact.list({ repoId, changelistNumber: cl }))
      .map((a) => a.path)
      .sort();
  /** Uploads the editor type, collecting unless files are named. */
  const upload = (opts: { files?: string[]; replace?: boolean } = {}) =>
    uploadArtifacts(builder, {
      changelistNumber: cl,
      type: EDITOR_TYPE,
      ...opts,
    });

  it("collects the files teamsync.yaml selects for the type, ignoring .chkignore", async () => {
    expect(await upload()).toEqual({
      type: EDITOR_TYPE,
      fileCount: 3,
      replaced: true,
    });
    expect(await pathsAt()).toEqual([
      "Engine/Binaries/Win64/Old.dll",
      "Engine/Binaries/Win64/UnrealEditor.exe",
      "Engine/Plugins/Foo/Binaries/Win64/Foo.dll",
    ]);
    expect((await setAt())?.fileCount).toBe(3);
  });

  it("replaces the set on the next collected upload, dropping files the build no longer makes", async () => {
    await upload();
    await rm(`${builder.root}/Engine/Binaries/Win64/Old.dll`);
    await put(builder, "Engine/Binaries/Win64/UnrealEditor.exe", "exe v2");

    await upload();
    expect(await pathsAt()).toEqual([
      "Engine/Binaries/Win64/UnrealEditor.exe",
      "Engine/Plugins/Foo/Binaries/Win64/Foo.dll",
    ]);
    expect((await setAt())?.fileCount).toBe(2);
  });

  it("adds named files and folders to the set, minus the exclude patterns", async () => {
    await upload({ files: ["Engine/Plugins/Foo/Binaries/Win64/Foo.dll"] });
    await upload({ files: ["Engine/Binaries"] });
    expect(await pathsAt()).toEqual([
      "Engine/Binaries/Win64/Old.dll",
      "Engine/Binaries/Win64/UnrealEditor.exe",
      "Engine/Plugins/Foo/Binaries/Win64/Foo.dll",
    ]);
  });

  it("replaces with named files when asked", async () => {
    await upload();
    await upload({
      files: ["Engine/Binaries/Win64/UnrealEditor.exe"],
      replace: true,
    });
    expect(await pathsAt()).toEqual(["Engine/Binaries/Win64/UnrealEditor.exe"]);
  });

  it("keeps each type's set apart", async () => {
    channels = [
      EDITOR,
      {
        type: "server-linux",
        requiredBadges: [],
        include: ["Engine/Intermediate/"],
        exclude: [],
      },
    ];
    await upload();
    await uploadArtifacts(builder, {
      changelistNumber: cl,
      type: "server-linux",
    });
    expect((await setAt(EDITOR_TYPE))?.fileCount).toBe(3);
    expect((await setAt("server-linux"))?.fileCount).toBe(1);

    // Replacing one leaves the other alone.
    await rm(`${builder.root}/Engine/Binaries/Win64/Old.dll`);
    await upload();
    expect((await setAt(EDITOR_TYPE))?.fileCount).toBe(2);
    expect((await setAt("server-linux"))?.fileCount).toBe(1);
  });

  it("refuses an upload that names no type, collecting or not", async () => {
    const daemon = await daemonApi();
    for (const files of [[], ["Engine/Binaries"]]) {
      await expect(
        daemon.workspaces.artifacts.upload({
          ...seatIds(builder),
          changelistNumber: cl,
          modifications: files.map((path) => ({ delete: false, path })),
        } as never),
      ).rejects.toThrow(/type/);
    }
    expect(await apiAs(builder).artifact.listSets({ repoId, changelistNumber: cl })).toEqual([]);
  });

  it("refuses to attach a set with no type at the server", async () => {
    await expect(
      apiAs(builder).artifact.attachToChangelist({
        repoId,
        changelistNumber: cl,
        versionIndex: "",
        modifications: [],
      } as never),
    ).rejects.toThrow(/type/);
  });

  it("refuses to collect for a type without include patterns", async () => {
    channels = [{ type: EDITOR_TYPE, requiredBadges: [] }];
    await expect(upload()).rejects.toThrow(
      /no include patterns for artifact type "editor-win64"/,
    );
    await expect(
      uploadArtifacts(builder, { changelistNumber: cl, type: "game" }),
    ).rejects.toThrow(/no include patterns for artifact type "game"/);
  });

  it("fails when the patterns match nothing", async () => {
    channels = [{ ...EDITOR, include: ["Game/Binaries/"] }];
    await expect(upload()).rejects.toThrow(
      /No files match the include patterns/,
    );
    expect(await setAt()).toBeUndefined();
  });

  it("refuses every upload through a native addon from before artifact types", async () => {
    fakeAddon.SUPPORTS_ARTIFACT_TYPES = false;
    try {
      await expect(upload()).rejects.toThrow(/too old to upload artifacts/);
      await expect(
        upload({ files: ["Engine/Binaries/Win64/UnrealEditor.exe"] }),
      ).rejects.toThrow(/too old to upload artifacts/);
    } finally {
      fakeAddon.SUPPORTS_ARTIFACT_TYPES = true;
    }
    expect(await setAt()).toBeUndefined();
  });

  it("is applied by a teammate's workspace that chose the type", async () => {
    await upload();
    await setTeamSync(teammate, { artifactTypes: [EDITOR_TYPE] });
    await syncLatest(teammate);

    expect(await read(teammate, "Engine/Source/Main.cpp")).toContain("main");
    expect(await read(teammate, "Engine/Binaries/Win64/UnrealEditor.exe")).toBe(
      "exe v1",
    );
    expect(exists(teammate, "Engine/Binaries/Win64/UnrealEditor.pdb")).toBe(
      false,
    );
  });

  it("is not applied by a workspace that chose no types", async () => {
    await upload();
    await setTeamSync(teammate, {});
    await syncLatest(teammate);

    expect(await read(teammate, "Engine/Source/Main.cpp")).toContain("main");
    expect(exists(teammate, "Engine/Binaries/Win64/UnrealEditor.exe")).toBe(
      false,
    );
  });

  it("removes a type's files on the next sync once the workspace stops choosing it", async () => {
    channels = [
      EDITOR,
      {
        type: "server-linux",
        requiredBadges: [],
        include: ["Engine/Intermediate/"],
        exclude: [],
      },
    ];
    await upload();
    await uploadArtifacts(builder, {
      changelistNumber: cl,
      type: "server-linux",
    });
    await setTeamSync(teammate, {
      artifactTypes: [EDITOR_TYPE, "server-linux"],
    });
    await syncLatest(teammate);
    expect(exists(teammate, "Engine/Binaries/Win64/UnrealEditor.exe")).toBe(
      true,
    );
    expect(exists(teammate, "Engine/Intermediate/Build/obj.o")).toBe(true);

    // Dropping one type removes only its files.
    await setTeamSync(teammate, { artifactTypes: [EDITOR_TYPE] });
    await syncLatest(teammate);
    expect(exists(teammate, "Engine/Binaries/Win64/UnrealEditor.exe")).toBe(
      true,
    );
    expect(exists(teammate, "Engine/Intermediate/Build/obj.o")).toBe(false);

    // Dropping the last removes the rest.
    await setTeamSync(teammate, { artifactTypes: [] });
    await syncLatest(teammate);
    expect(exists(teammate, "Engine/Binaries/Win64/UnrealEditor.exe")).toBe(
      false,
    );
    expect(await read(teammate, "Engine/Source/Main.cpp")).toContain("main");
  });
});
