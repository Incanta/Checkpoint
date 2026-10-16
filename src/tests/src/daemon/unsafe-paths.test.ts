/**
 * Paths a workspace must never touch: ones that climb out of it, name its own
 * .checkpoint directory, or (on Windows) contain a ":" that NTFS reads as a
 * stream separator. The server refuses them now (src/api/repo-paths.test.ts),
 * but repositories already hold some and older servers still send them, so
 * the daemon checks every path itself (src/core/daemon/src/util/
 * workspace-path.ts). Moved here from the data-loss red team (DL-03, DL-17,
 * DL-23).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts). Changelists are
 * recorded with the server's path rules off, as an older server stored them.
 */
import { promises as fsp, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

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
import {
  getWorkspaceState,
  updateWorkspaceState,
} from "../../../core/daemon/src/util/util.js";
import type { PullMergeResult } from "../../../core/daemon/src/util/pull.js";
import {
  describeFile,
  exists,
  filesystemIsCaseInsensitive,
  filesystemKeepsShortNames,
  makeScene,
  pendingChanges,
  put,
  resetStack,
  setTeamSync,
  stageAndSubmit,
  submitDirect,
  survives,
  syncLatest,
  tearDownScene,
  utilWorkspace,
  type Scene,
} from "../harness/stack";

const caseInsensitive = await filesystemIsCaseInsensitive();
const keepsShortNames = await filesystemKeepsShortNames();
const windows = process.platform === "win32";

describe("paths a workspace must not touch", () => {
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  /** A file beside Bob's workspace, which no pull may touch. */
  async function besideBobsWorkspace(): Promise<string> {
    const outside = path.join(
      path.dirname(scene!.bob.root),
      `not-a-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    await writeFile(outside, "a file that belongs to nobody's workspace\n");
    return outside;
  }

  it.each([
    (name: string) => `../${name}`,
    (name: string) => `Content/../../${name}`,
    (name: string) => `Content/Maps/../../../${name}`,
  ])(
    "never deletes a file outside the workspace for a path that climbs out of it (%#)",
    async (spell) => {
      const { alice, bob } = scene!;
      const outside = await besideBobsWorkspace();
      const climbing = spell(path.basename(outside));
      try {
        const added = await submitDirect(alice, {
          write: { [climbing]: "planted\n" },
        });
        // Bob is at that changelist (whatever the native pull did with it).
        await updateWorkspaceState(
          utilWorkspace(bob),
          { meta: { changelistNumber: added } },
          "sqlite",
        );
        await submitDirect(alice, { remove: [climbing] });

        await syncLatest(bob);

        expect(existsSync(outside), `Bob's pull deleted ${outside}`).toBe(true);
      } finally {
        await fsp.rm(outside, { force: true });
      }
    },
  );

  it("never writes a file outside the workspace, and reports what it left out", async () => {
    const { alice, bob } = scene!;
    const outside = await besideBobsWorkspace();
    const climbing = `../${path.basename(outside)}`;
    try {
      await put(alice, "Docs/readme.txt", "hello\n");
      await stageAndSubmit(alice, ["Docs"]);
      await submitDirect(alice, { write: { [climbing]: "planted\n" } });

      const result = (await syncLatest(bob)) as PullMergeResult;

      expect(await fsp.readFile(outside, "utf8")).toBe(
        "a file that belongs to nobody's workspace\n",
      );
      expect(exists(bob, "Docs/readme.txt")).toBe(true);
      expect(result.unsafePaths?.map((u) => u.path)).toEqual([climbing]);
      const state = await getWorkspaceState(bob.root, "sqlite");
      expect(Object.keys(state.files)).toEqual(["Docs/readme.txt"]);
      expect(await pendingChanges(bob)).toEqual({});
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it("does not show a path an older daemon recorded but cannot hold as deleted, and forgets it once it is removed", async () => {
    // An older daemon pulled "../stray.txt" and recorded it. It cannot exist
    // inside the workspace, so it must not look deleted by the user: a
    // "submit everything" would then delete it for the team.
    const { alice, bob } = scene!;
    const added = await submitDirect(alice, {
      write: { "../stray.txt": "planted\n" },
    });
    await updateWorkspaceState(
      utilWorkspace(bob),
      {
        files: {
          upsert: {
            "../stray.txt": {
              fileId: "f",
              changelist: added,
              md5: "",
              size: 8,
              mtime: 1,
            },
          },
        },
        meta: { changelistNumber: added },
      },
      "sqlite",
    );
    expect(await pendingChanges(bob)).toEqual({});

    await submitDirect(alice, { remove: ["../stray.txt"] });
    await syncLatest(bob);

    const state = await getWorkspaceState(bob.root, "sqlite");
    expect(state.files).not.toHaveProperty("../stray.txt");
  });

  it.runIf(windows)(
    "leaves nothing pending after pulling a file a Mac or Linux user named with a colon",
    async () => {
      // NTFS reads "standup 10:15.txt" as the stream "15.txt" of a file named
      // "standup 10". The pull leaves it out and says so.
      const { alice, bob } = scene!;
      await submitDirect(alice, {
        write: { "Notes/standup 10:15.txt": "who is doing what\n" },
      });

      const result = (await syncLatest(bob)) as PullMergeResult;

      expect(await pendingChanges(bob)).toEqual({});
      expect(exists(bob, "Notes/standup 10")).toBe(false);
      expect(result.unsafePaths?.map((u) => u.path)).toEqual([
        "Notes/standup 10:15.txt",
      ]);
    },
  );

  it.runIf(!windows)(
    "pulls a file named with a colon where the filesystem allows it",
    async () => {
      const { alice, bob } = scene!;
      await submitDirect(alice, {
        write: { "Notes/standup 10:15.txt": "who is doing what\n" },
      });

      await syncLatest(bob);

      expect(
        await survives(bob, "Notes/standup 10:15.txt", "who is doing"),
      ).toBe(true);
    },
  );

  describe("the workspace's own .checkpoint directory", () => {
    /**
     * Bob has synced and has an unsubmitted edit. Another client records a
     * changelist that adds a workspace.json under `spelling`, narrowing the
     * sync filter to nothing, and Bob syncs.
     */
    async function plantWorkspaceConfig(spelling: string) {
      const { alice, bob } = scene!;
      await put(alice, "Source/game.cpp", "int main() { return 0; }\n");
      await put(alice, "Content/level.txt", "level\n");
      await stageAndSubmit(alice, ["Source", "Content"]);
      await syncLatest(bob);
      await setTeamSync(bob, {});
      await put(
        bob,
        "Content/level.txt",
        "level, plus bob's unsubmitted edits\n",
      );

      await submitDirect(alice, {
        write: {
          [`${spelling}/workspace.json`]: JSON.stringify({
            teamSync: { customIncludeRules: ["Nothing/"] },
          }),
        },
      });
      await syncLatest(bob);
    }

    for (const [spelling, applies, where] of [
      [".checkpoint", true, "everywhere"],
      [".CHECKPOINT", caseInsensitive, "Windows and macOS"],
      ["CHECKP~1", keepsShortNames, "Windows volumes with 8.3 short names"],
      [".checkpoint.", windows, "Windows, which strips trailing dots"],
    ] as const) {
      it.runIf(applies)(
        `does not let a pull replace the workspace's config through ${spelling}/workspace.json (${where})`,
        async () => {
          const { bob } = scene!;
          await plantWorkspaceConfig(spelling);

          expect(
            exists(bob, "Source/game.cpp") &&
              (await survives(
                bob,
                "Content/level.txt",
                "bob's unsubmitted edits",
              )),
            `${await describeFile(bob, ".checkpoint/workspace.json")}; ` +
              `${await describeFile(bob, "Source/game.cpp")}; ` +
              `${await describeFile(bob, "Content/level.txt")}`,
          ).toBe(true);
        },
      );
    }
  });

  it("still scans a file whose name only starts with .checkpoint", async () => {
    const { bob } = scene!;
    await put(bob, ".checkpointrc", "settings\n");
    expect(Object.keys(await pendingChanges(bob))).toEqual([".checkpointrc"]);
  });
});
