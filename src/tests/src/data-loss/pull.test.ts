/**
 * Red team: a pull must never lose local work, or leave the workspace
 * believing it has content it does not.
 *
 * Driven through the daemon's own endpoints (stage, submit, pull, pending
 * changes) against the real app routers, with only the native addon faked
 * (see ./stack.ts). Each test states the safe outcome; a failure is an open
 * bug, written up in ./README.md under the same name.
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
  apiAs,
  asOlderServer,
  backupsContaining,
  describeFile,
  filesystemIsCaseInsensitive,
  fileIn,
  makeScene,
  overrides,
  pendingChanges,
  put,
  read,
  resetStack,
  stageAndSubmit,
  storeVersion,
  survives,
  syncLatest,
  tearDownScene,
  utilWorkspace,
  type Scene,
} from "../harness/stack";

const caseInsensitive = await filesystemIsCaseInsensitive();

describe("data loss: pull", () => {
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

  const FIVE_LINES = "one\ntwo\nthree\nfour\nfive\n";
  /** A pending-changes status for a locally modified tracked file. */
  const stillPending = expect.stringMatching(/^Changed/);

  it("control: merges a local edit with an upstream change to the same text file", async () => {
    // Shows the harness reproduces the protection that does work: the guard
    // backs the edit up, the pull writes the server's version, and a three
    // way merge puts both together.
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", FIVE_LINES);
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);

    await put(bob, "notes.txt", FIVE_LINES.replace("one", "one (bob)"));
    await put(alice, "notes.txt", FIVE_LINES.replace("five", "five (alice)"));
    await stageAndSubmit(alice, ["notes.txt"]);

    await syncLatest(bob);

    expect(await read(bob, "notes.txt")).toBe(
      "one (bob)\ntwo\nthree\nfour\nfive (alice)\n",
    );
    expect(await pendingChanges(bob)).toHaveProperty(
      ["notes.txt"],
      stillPending,
    );
  });

  it("does not record an edit made while the pull runs as the version it pulled", async () => {
    // A big sync runs for minutes, and people keep working (or leave the
    // editor open, which resaves). notes.txt is written early; Bob changes it
    // before the pull finishes. The pull then stats every file it pulled and
    // records that as the pristine baseline, so the edit stops being a local
    // change and the next upstream change overwrites it with no backup.
    // submit() records the stat it took before reading for exactly this
    // reason (statBeforeSubmit in util/submit.ts); the pull does not.
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "v1\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);
    await put(alice, "notes.txt", "v2 from alice\n");
    await stageAndSubmit(alice, ["notes.txt"]);

    overrides.duringPull = () =>
      put(
        bob,
        "notes.txt",
        "v2 from alice\nbob's edit, made during the pull\n",
      );
    await syncLatest(bob);
    delete overrides.duringPull;

    expect
      .soft(
        await pendingChanges(bob),
        "notes.txt differs from what the pull wrote, so it must be pending",
      )
      .toHaveProperty(["notes.txt"], stillPending);

    await put(alice, "notes.txt", "v3 from alice\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);

    expect(
      await survives(bob, "notes.txt", "made during the pull"),
      `${await describeFile(bob, "notes.txt")}, and no backup holds Bob's edit`,
    ).toBe(true);
  });

  it.skipIf(!caseInsensitive)(
    "brings the new content of a file renamed by case only (case-insensitive filesystems)",
    async () => {
      // Alice (on Linux, or any client) renames Textures/hero.txt to
      // Textures/Hero.txt and updates it in one changelist. On Bob's Windows
      // machine the pull writes "Hero.txt" onto the existing hero.txt, then
      // its delete pass removes "hero.txt", which is the same file. The guard
      // had copied the old file aside as an "untracked" Hero.txt, so it puts
      // the OLD content back, and the state records it as the new version.
      const { alice, bob } = scene!;
      await put(alice, "Textures/hero.txt", "hero, original\n");
      await stageAndSubmit(alice, ["Textures/hero.txt"]);
      await syncLatest(bob);

      const head = (
        await testDb.client.branch.findFirstOrThrow({
          where: { repoId: scene!.repoId, name: "main" },
        })
      ).headNumber;
      await apiAs(alice).changelist.createChangelist({
        message: "rename hero.txt to Hero.txt and update it",
        repoId: scene!.repoId,
        versionIndex: storeVersion({
          "Textures/Hero.txt": "hero, updated by alice\n",
        }),
        branchName: "main",
        modifications: [
          { path: "Textures/hero.txt", delete: true, baseChangelist: head },
          { path: "Textures/Hero.txt", delete: false, baseChangelist: null },
        ],
        keepCheckedOut: false,
        workspaceId: alice.workspace.id,
      });

      await syncLatest(bob);

      const recorded = (await getWorkspaceState(bob.root, "sqlite")).files[
        "Textures/Hero.txt"
      ];
      expect(
        await read(bob, "Textures/Hero.txt"),
        `the workspace state records Textures/Hero.txt at #${recorded?.changelist}, ` +
          `and nothing shows it as changed: ${JSON.stringify(await pendingChanges(bob))}`,
      ).toBe("hero, updated by alice\n");
    },
  );

  it("records the workspace at the pulled changelist (sanity check of the harness)", async () => {
    const { alice, bob } = scene!;
    await put(alice, "a.txt", "a\n");
    await stageAndSubmit(alice, ["a.txt"]);
    await syncLatest(bob);
    const state = await getWorkspaceState(bob.root, "sqlite");
    expect(state.changelistNumber).toBe(1);
    expect(state.files["a.txt"]?.changelist).toBe(1);
  });
});
