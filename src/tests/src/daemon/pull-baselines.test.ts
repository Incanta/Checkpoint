/**
 * What a pull records as each file's baseline (the size and mtime that
 * change detection compares with). It records only what it wrote: a file the
 * workspace already had at the incoming changelist, because this workspace
 * submitted it, may hold edits made since, and re-recording it would hide
 * them from pending changes and let a later pull overwrite them. Moved here
 * from the data-loss red team (DL-01, DL-06).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts).
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
  stage,
  stageAndSubmit,
  storeVersion,
  survives,
  syncLatest,
  tearDownScene,
  utilWorkspace,
  type Scene,
} from "../harness/stack";

const caseInsensitive = await filesystemIsCaseInsensitive();

describe("pull baselines", () => {
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

  /**
   * Bob submits notes.txt while Alice's other.txt has landed since his last
   * pull, so his workspace keeps its old changelist number and records
   * notes.txt individually at his new changelist. He goes on editing it. The
   * next pull sees notes.txt "already at" the incoming changelist, skips it
   * (correct), and then records its current size and mtime as the pristine
   * baseline (wrong): the unsubmitted edit stops being a pending change.
   */
  async function bobEditsAfterSubmittingBehindHead() {
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "v1\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);

    await put(alice, "other.txt", "someone else's work\n");
    await stageAndSubmit(alice, ["other.txt"]);

    await put(bob, "notes.txt", "v2 from bob\n");
    await stageAndSubmit(bob, ["notes.txt"]);
    await put(
      bob,
      "notes.txt",
      "v3 from bob, an afternoon of work not submitted yet\n",
    );

    expect(await pendingChanges(bob)).toHaveProperty(
      ["notes.txt"],
      stillPending,
    );
  }

  it("keeps an edit made after a submit as a pending change across the next pull", async () => {
    const { bob } = scene!;
    await bobEditsAfterSubmittingBehindHead();

    await syncLatest(bob);

    expect(await read(bob, "notes.txt")).toContain("an afternoon of work");
    expect(
      await pendingChanges(bob),
      "notes.txt still differs from what Bob submitted, so it must stay pending",
    ).toHaveProperty(["notes.txt"], stillPending);
  });

  it("does not overwrite that edit when the file next changes upstream", async () => {
    const { alice, bob } = scene!;
    await bobEditsAfterSubmittingBehindHead();
    await syncLatest(bob);

    await syncLatest(alice);
    await put(alice, "notes.txt", "v4 from alice, who pulled bob's v2 first\n");
    await stageAndSubmit(alice, ["notes.txt"]);

    const result = (await syncLatest(bob)) as PullMergeResult;

    // Either merged into the file (with conflict markers here, since both
    // changed the one line) or set aside in a backup the pull reports.
    expect(
      await survives(bob, "notes.txt", "an afternoon of work"),
      `${await describeFile(bob, "notes.txt")}, and no backup holds Bob's edit`,
    ).toBe(true);
    expect(result.conflictMerges).toContain("notes.txt");
  });

  it("keeps that edit when the pull falls back to applying whole version indexes", async () => {
    // The single-pass pull fails over to applying each changelist's whole
    // index when teammates' daemons indexed with different hashing or chunk
    // settings. Bob's own changelist's index holds his submitted v2, and
    // applying it rewrites notes.txt, which the guard skipped as up to date.
    const { bob } = scene!;
    await bobEditsAfterSubmittingBehindHead();
    overrides.selectionPullFailure =
      "Version indexes were written with different hashing or chunk sizes";

    await syncLatest(bob);

    expect(
      await survives(bob, "notes.txt", "an afternoon of work"),
      `${await describeFile(bob, "notes.txt")}, and no backup holds Bob's edit`,
    ).toBe(true);
  });

  const FALLBACK =
    "Version indexes were written with different hashing or chunk sizes";

  it("keeps that edit pending when the pull falls back to whole indexes", async () => {
    const { bob } = scene!;
    await bobEditsAfterSubmittingBehindHead();
    overrides.selectionPullFailure = FALLBACK;

    await syncLatest(bob);

    expect(await read(bob, "notes.txt")).toContain("an afternoon of work");
    expect(await pendingChanges(bob)).toHaveProperty(
      ["notes.txt"],
      stillPending,
    );
    expect(await backupsContaining(bob, "an afternoon of work")).toEqual([]);
  });

  it("puts a binary edit back, rather than setting it aside, when whole indexes rewrite it", async () => {
    // Upstream did not change the file; only the fallback rewrote it.
    const { alice, bob } = scene!;
    await put(alice, "hero.uasset", "hero v1");
    await stageAndSubmit(alice, ["hero.uasset"]);
    await syncLatest(bob);
    await put(bob, "hero.uasset", "hero v2");
    await stage(bob, ["hero.uasset"]);
    await put(alice, "other.txt", "someone else's work\n");
    await stageAndSubmit(alice, ["other.txt"]);
    await stageAndSubmit(bob, ["hero.uasset"]);
    await put(bob, "hero.uasset", "hero v3, unsubmitted");
    overrides.selectionPullFailure = FALLBACK;

    const result = (await syncLatest(bob)) as PullMergeResult;

    expect(await read(bob, "hero.uasset")).toBe("hero v3, unsubmitted");
    expect(result.localChangesSetAside).toEqual([]);
    expect(await pendingChanges(bob)).toHaveProperty(
      ["hero.uasset"],
      stillPending,
    );
  });

  it("leaves an unedited file it rewrote with the same content out of pending changes", async () => {
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "v1\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);
    await put(alice, "other.txt", "someone else's work\n");
    await stageAndSubmit(alice, ["other.txt"]);
    await put(bob, "notes.txt", "v2 from bob\n");
    await stageAndSubmit(bob, ["notes.txt"]);
    overrides.selectionPullFailure = FALLBACK;

    await syncLatest(bob);

    expect(await read(bob, "notes.txt")).toBe("v2 from bob\n");
    expect(await pendingChanges(bob)).toEqual({});
  });

  it("still records a file the pull did write", async () => {
    const { alice, bob } = scene!;
    await bobEditsAfterSubmittingBehindHead();
    await syncLatest(bob);

    expect(await read(bob, "other.txt")).toBe("someone else's work\n");
    expect(await pendingChanges(bob)).not.toHaveProperty("other.txt");
    const state = await getWorkspaceState(bob.root, "sqlite");
    expect(state.files["other.txt"]?.size).toBe(
      Buffer.byteLength("someone else's work\n"),
    );
    void alice;
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
});
