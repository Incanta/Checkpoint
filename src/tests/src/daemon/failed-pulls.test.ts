/**
 * A pull that cannot finish must leave every local edit in place, and one
 * file it cannot remove must not stop it. Moved here from the data-loss red
 * team (DL-05, DL-25).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts). The Windows tests
 * hold a real lock from a PowerShell process, the way the Unreal Editor holds
 * a package it has loaded.
 */
import { promises as fsp } from "node:fs";

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
import type { PullMergeResult } from "../../../core/daemon/src/util/pull.js";
import {
  backupsContaining,
  exists,
  fileIn,
  holdOpen,
  makeScene,
  pendingChanges,
  put,
  read,
  resetStack,
  stageAndSubmit,
  survives,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

const windows = process.platform === "win32";

describe("pulls that cannot finish", () => {
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

  /**
   * Bob edited a.txt; Alice changed it and deleted b.txt, which Bob cannot
   * remove (open in another program). Runs the pull with `hold` keeping
   * b.txt from being removed, and returns its result.
   */
  async function pullWhileBIsHeld(
    hold: (bPath: string) => Promise<() => Promise<void>>,
  ): Promise<PullMergeResult> {
    const { alice, bob } = scene!;
    await put(alice, "a.txt", "a: line one\n");
    await put(alice, "b.txt", "b: will be deleted upstream\n");
    await stageAndSubmit(alice, ["a.txt", "b.txt"]);
    await syncLatest(bob);

    await put(bob, "a.txt", "a: line one\nbob's local line\n");
    await put(alice, "a.txt", "a: alice rewrote this line\n");
    await fsp.rm(fileIn(alice, "b.txt"));
    await stageAndSubmit(alice, ["a.txt", "b.txt"]);

    const release = await hold(fileIn(bob, "b.txt"));
    try {
      return (await syncLatest(bob)) as PullMergeResult;
    } finally {
      await release();
    }
  }

  /** Makes deleting one file fail as Windows does when it is in use. */
  async function simulatedLock(target: string) {
    const realRm = fsp.rm.bind(fsp);
    const spy = vi.spyOn(fsp, "rm").mockImplementation(async (p, options) => {
      if (String(p) === target) {
        throw Object.assign(
          new Error("EBUSY: resource busy or locked, unlink"),
          { code: "EBUSY" },
        );
      }
      return realRm(p, options);
    });
    return async () => spy.mockRestore();
  }

  async function expectBStillTrackedAndRetried(result: PullMergeResult) {
    const { bob } = scene!;
    expect(result.notRemoved?.map((n) => n.path)).toEqual(["b.txt"]);
    // Still tracked, so it never shows as an untracked file to add back.
    expect(await pendingChanges(bob)).not.toHaveProperty("b.txt");
    const state = await getWorkspaceState(bob.root, "sqlite");
    expect(state.files).toHaveProperty("b.txt");
    expect(state.pendingRemovals).toEqual(["b.txt"]);

    // Once it is free, the next pull removes it.
    await syncLatest(bob);
    expect(exists(bob, "b.txt")).toBe(false);
    const after = await getWorkspaceState(bob.root, "sqlite");
    expect(after.files).not.toHaveProperty("b.txt");
    expect(after.pendingRemovals).toBeUndefined();
  }

  it("finishes the pull when it cannot remove a file the server deleted, and keeps the local edit", async () => {
    const { bob } = scene!;
    const result = await pullWhileBIsHeld(simulatedLock);

    expect(await survives(bob, "a.txt", "bob's local line")).toBe(true);
    expect(await survives(bob, "a.txt", "alice rewrote")).toBe(true);
    await expectBStillTrackedAndRetried(result);
  });

  it.runIf(windows)(
    "finishes the pull when a file the server deleted is open in the Unreal Editor",
    async () => {
      const { bob } = scene!;
      const result = await pullWhileBIsHeld((p) => holdOpen(p, "read"));

      expect(await survives(bob, "a.txt", "bob's local line")).toBe(true);
      await expectBStillTrackedAndRetried(result);
    },
  );

  it("stops retrying a file it could not remove once the user edits it, and keeps it tracked", async () => {
    const { bob } = scene!;
    await pullWhileBIsHeld(simulatedLock);
    await put(bob, "b.txt", "b: bob kept working on it\n");

    await syncLatest(bob);

    expect(await read(bob, "b.txt")).toBe("b: bob kept working on it\n");
    const state = await getWorkspaceState(bob.root, "sqlite");
    expect(state.files).toHaveProperty("b.txt");
    expect(state.pendingRemovals).toBeUndefined();
    expect(await pendingChanges(bob)).toHaveProperty(
      "b.txt",
      expect.stringMatching(/^Changed/),
    );
  });

  it.runIf(windows)(
    "puts every local edit back when the pull cannot write a file open in the Unreal Editor",
    async () => {
      // Bob saved changes to the hero and to his notes, and still has the
      // hero open in the editor; Alice changed both. The native pass writes
      // the notes and fails on the hero, so the pull puts the backups back.
      // Putting the hero's backup back fails for the same reason, and that
      // stops the loop before it reaches the notes.
      const { alice, bob } = scene!;
      await put(alice, "Content/Hero.uasset", "hero v1");
      await put(alice, "Docs/notes.txt", "notes v1\n");
      await stageAndSubmit(alice, ["Content/Hero.uasset", "Docs/notes.txt"]);
      await syncLatest(bob);

      await put(bob, "Content/Hero.uasset", "hero v1, sculpted by bob");
      await put(bob, "Docs/notes.txt", "notes v1\nbob's notes\n");
      await put(alice, "Content/Hero.uasset", "hero v2 from alice");
      await put(alice, "Docs/notes.txt", "notes v2 from alice\n");
      await stageAndSubmit(alice, ["Content/Hero.uasset", "Docs/notes.txt"]);

      let failure = "the pull succeeded";
      const release = await holdOpen(
        fileIn(bob, "Content/Hero.uasset"),
        "read",
      );
      try {
        await syncLatest(bob).catch((e: unknown) => {
          failure = `the pull failed with "${(e as Error).message}"`;
        });
      } finally {
        await release();
      }

      const backups = await backupsContaining(bob, "bob's notes");
      expect(
        await read(bob, "Docs/notes.txt"),
        `${failure}; Bob's notes are only in ${backups.length ? backups.join(", ") : "no backup at all"}`,
      ).toBe("notes v1\nbob's notes\n");
    },
  );

  it.runIf(windows)(
    "control: does not start writing when an edited file is open in a program that denies all sharing",
    async () => {
      // What does hold up: a file the pull cannot copy aside stops the pull
      // before anything in the workspace changes.
      const { alice, bob } = scene!;
      await put(alice, "Docs/budget.xlsx", "q3 budget");
      await stageAndSubmit(alice, ["Docs/budget.xlsx"]);
      await syncLatest(bob);

      await put(bob, "Docs/budget.xlsx", "q3 budget with bob's numbers");
      await put(alice, "Docs/budget.xlsx", "q3 budget, revised by alice");
      await put(alice, "Docs/other.txt", "something else alice added\n");
      await stageAndSubmit(alice, ["Docs/budget.xlsx", "Docs/other.txt"]);
      const before = (await getWorkspaceState(bob.root, "sqlite"))
        .changelistNumber;

      const release = await holdOpen(fileIn(bob, "Docs/budget.xlsx"), "none");
      try {
        await expect(syncLatest(bob)).rejects.toThrow(/EBUSY/);
      } finally {
        await release();
      }

      expect(await read(bob, "Docs/budget.xlsx")).toBe(
        "q3 budget with bob's numbers",
      );
      expect(exists(bob, "Docs/other.txt")).toBe(false);
      expect(
        (await getWorkspaceState(bob.root, "sqlite")).changelistNumber,
      ).toBe(before);
    },
  );

  it.runIf(windows)(
    "leaves a binary the pull could not write as the user had it",
    async () => {
      const { alice, bob } = scene!;
      await put(alice, "Content/Hero.uasset", "hero v1");
      await stageAndSubmit(alice, ["Content/Hero.uasset"]);
      await syncLatest(bob);
      await put(bob, "Content/Hero.uasset", "hero v1, sculpted by bob");
      await put(alice, "Content/Hero.uasset", "hero v2 from alice");
      await stageAndSubmit(alice, ["Content/Hero.uasset"]);

      const release = await holdOpen(
        fileIn(bob, "Content/Hero.uasset"),
        "read",
      );
      let message = "";
      try {
        await syncLatest(bob).catch((e: unknown) => {
          message = (e as Error).message;
        });
      } finally {
        await release();
      }

      // The lock kept the native write out, so the file still holds Bob's
      // version and counts as put back: no backup is left behind for it.
      expect(message).toMatch(/Pull failed/);
      expect(await read(bob, "Content/Hero.uasset")).toBe(
        "hero v1, sculpted by bob",
      );
      expect((await backupsContaining(bob, "sculpted by bob")).length).toBe(0);
    },
  );
});
