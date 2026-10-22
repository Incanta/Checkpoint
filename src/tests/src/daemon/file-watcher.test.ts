/**
 * The daemon's file watcher and the pending-changes cache it keeps current.
 *
 * The manager caches each workspace's pending list and re-examines only the
 * paths the watcher reported (the dirty set) on the next refresh. That is
 * correct only while every change reaches the dirty set, so whenever the
 * watcher may have missed some (an overflowed change buffer, a failed
 * watcher, no watcher at all) the cache has to go and the next refresh has
 * to rescan (R20 in docs/data-loss-fix-plan.md, "Watcher gaps").
 *
 * The overflow and the failure cannot be produced on demand, so most tests
 * install a stand-in watcher that reports nothing and feed the manager's
 * handlers synthetic events (handleWatchEvent, handleWatchError). That also
 * lets a test make an edit the watcher "never reported" and check whether
 * the cache hides it. The last tests run the real fs.watch against the
 * workspace and wait for the change to show.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts). Wherever the
 * incremental result matters, it is also compared with a forced full rescan.
 */
import { EventEmitter } from "node:events";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

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
import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import { FileStatus } from "../../../core/daemon/src/types/index.js";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import {
  daemonLog,
  detachSeat,
  fileIn,
  makeScene,
  pendingChanges,
  put,
  resetStack,
  stageAndSubmit,
  tearDownScene,
  type Scene,
  type Seat,
} from "../harness/stack";

const manager = () => DaemonManager.Get();

/** The manager's private watcher bookkeeping, for installing a stand-in. */
const internals = () =>
  manager() as unknown as {
    watchers: Map<string, unknown>;
    watcherRetries: Map<string, unknown>;
    vcsOperationActive: Map<string, boolean>;
  };

/**
 * A submit's job reports done before the submit's VCS operation ends (that
 * waits out a grace period for late watcher events), and until then events
 * are buffered rather than marked dirty. Wait for it.
 */
async function submit(seat: Seat, paths: string[]): Promise<void> {
  await stageAndSubmit(seat, paths);
  await waitFor(
    "the submit's VCS operation to end",
    () => !internals().vcsOperationActive.get(seat.workspace.id),
  );
}

const ws = (seat: Seat) => seat.workspace as never;

/**
 * Registers a watcher that reports nothing, so the manager trusts its cache
 * and the test decides which events arrive. Returns it so a test can emit on
 * it.
 */
function installSilentWatcher(seat: Seat) {
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  internals().watchers.set(seat.workspace.id, watcher);
  return watcher;
}

const event = (seat: Seat, eventType: string, filename: string | null) =>
  manager().handleWatchEvent(ws(seat), eventType, filename);

const dirty = (seat: Seat) => [...manager().getDirtyFiles(seat.workspace.id)];

/** A forced full rescan, the oracle an incremental result must agree with. */
async function fullRescan(seat: Seat): Promise<Record<string, string>> {
  const result = await manager().refreshWorkspaceContents(ws(seat), {
    forceFullRefresh: true,
  });
  const out: Record<string, string> = {};
  for (const [p, f] of Object.entries(result.files)) {
    out[p] = FileStatus[f.status] ?? String(f.status);
  }
  return out;
}

async function waitFor(
  what: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("the file watcher", { timeout: 120_000 }, () => {
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
    DaemonManager.watcherRetryMs = 5000;
    vi.restoreAllMocks();
    // Unlinking closes any watcher and cancels any pending restart.
    await tearDownScene(scene);
    closeAllStateStores();
    scene = undefined;
  });

  /** Alice with a.txt and b.txt submitted, a silent watcher, and a warm cache. */
  async function tracked(): Promise<Seat> {
    const { alice } = scene!;
    await put(alice, "a.txt", "a\n");
    await put(alice, "b.txt", "b\n");
    await submit(alice, ["a.txt", "b.txt"]);
    installSilentWatcher(alice);
    expect(await pendingChanges(alice)).toEqual({});
    return alice;
  }

  describe("with the cache warm", () => {
    it("hides an edit the watcher never reported (the gap the next tests close)", async () => {
      const alice = await tracked();
      await put(alice, "a.txt", "edited, unreported\n");
      // The cache is trusted and nothing is dirty: the edit stays hidden.
      expect(await pendingChanges(alice)).toEqual({});
      expect(await fullRescan(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });

    it("shows a reported edit on an incremental refresh, and only that path", async () => {
      const alice = await tracked();
      await put(alice, "a.txt", "edited and reported\n");
      await put(alice, "b.txt", "edited, unreported\n");
      await event(alice, "change", "a.txt");
      expect(dirty(alice)).toEqual(["a.txt"]);
      // Incremental: only the dirty path was looked at again.
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
      expect(dirty(alice)).toEqual([]);
    });

    it("takes the OS's separators in an event's name", async () => {
      const { alice } = scene!;
      await put(alice, "dir/a.txt", "a\n");
      await submit(alice, ["dir/a.txt"]);
      installSilentWatcher(alice);
      expect(await pendingChanges(alice)).toEqual({});

      await put(alice, "dir/a.txt", "edited\n");
      await event(
        alice,
        "change",
        process.platform === "win32" ? "dir\\a.txt" : "dir/a.txt",
      );
      expect(dirty(alice)).toEqual(["dir/a.txt"]);
      expect(await pendingChanges(alice)).toEqual({
        "dir/a.txt": "ChangedNotCheckedOut",
      });
    });

    it("drops the cache on an event with no name (an overflowed buffer on Windows)", async () => {
      const alice = await tracked();
      await put(alice, "a.txt", "edited, lost in the overflow\n");
      await event(alice, "rename", null);
      expect(manager().workspacePendingChanges.has(alice.workspace.id)).toBe(
        false,
      );
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });

    it("drops the cache on a nameless event that arrives during a VCS operation", async () => {
      const alice = await tracked();
      manager().beginVcsOperation(alice.workspace.id);
      try {
        await put(alice, "a.txt", "edited during the pull, lost\n");
        await event(alice, "change", null);
      } finally {
        await manager().endVcsOperation(alice.workspace.id);
      }
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });

    it("buffers events during a VCS operation and replays them after it", async () => {
      const alice = await tracked();
      manager().beginVcsOperation(alice.workspace.id);
      try {
        await put(alice, "a.txt", "edited during the pull\n");
        await event(alice, "change", "a.txt");
        expect(dirty(alice)).toEqual([]);
      } finally {
        await manager().endVcsOperation(alice.workspace.id);
      }
      expect(dirty(alice)).toEqual(["a.txt"]);
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });
  });

  describe("paths that never dirty anything", () => {
    it("ignores events inside .checkpoint", async () => {
      const alice = await tracked();
      await event(alice, "change", ".checkpoint/state.db");
      await event(alice, "change", ".checkpoint/pull-backups/x/a.txt");
      await event(alice, "rename", ".checkpoint");
      expect(dirty(alice)).toEqual([]);
      expect(manager().workspacePendingChanges.has(alice.workspace.id)).toBe(
        true,
      );
    });

    it("does not take a user file named like .checkpoint for the directory", async () => {
      // The full scan lists ".checkpointrc"; the watcher and the incremental
      // refresh used to skip every path starting with ".checkpoint", so an
      // edit to it never showed until a full rescan.
      const alice = await tracked();
      await put(alice, ".checkpointrc", "user settings\n");
      await event(alice, "rename", ".checkpointrc");
      expect(dirty(alice)).toEqual([".checkpointrc"]);
      expect(await pendingChanges(alice)).toEqual({ ".checkpointrc": "Local" });
      expect(await fullRescan(alice)).toEqual({ ".checkpointrc": "Local" });
    });

    it("ignores events under ignored and hidden paths", async () => {
      const { alice } = scene!;
      await put(alice, ".chkignore", "Intermediate/\n*.log\n");
      await put(alice, ".chkhidden", "Saved/\n");
      await put(alice, "a.txt", "a\n");
      await submit(alice, ["a.txt", ".chkignore", ".chkhidden"]);
      await manager().scanIgnoreFiles(ws(alice));
      installSilentWatcher(alice);
      expect(await pendingChanges(alice)).toEqual({});

      await put(alice, "Intermediate/obj/x.o", "obj\n");
      await put(alice, "debug.log", "log\n");
      await put(alice, "Saved/autosave.dat", "save\n");
      for (const p of [
        "Intermediate",
        "Intermediate/obj",
        "Intermediate/obj/x.o",
        "debug.log",
        "Saved/autosave.dat",
      ]) {
        await event(alice, "rename", p);
      }
      expect(dirty(alice)).toEqual([]);
      expect(await pendingChanges(alice)).toEqual({});
      expect(await fullRescan(alice)).toEqual({});
    });

    it("rescans when an ignore file changes, so newly ignored paths leave the list", async () => {
      const alice = await tracked();
      await put(alice, "debug.log", "log\n");
      await event(alice, "rename", "debug.log");
      expect(await pendingChanges(alice)).toEqual({ "debug.log": "Local" });

      await put(alice, ".chkignore", "*.log\n");
      await event(alice, "rename", ".chkignore");
      expect(manager().workspacePendingChanges.has(alice.workspace.id)).toBe(
        false,
      );
      expect(await pendingChanges(alice)).toEqual({ ".chkignore": "Local" });
    });
  });

  describe("deletes and renames", () => {
    it("shows a deleted tracked file", async () => {
      const alice = await tracked();
      await rm(fileIn(alice, "a.txt"));
      await event(alice, "rename", "a.txt");
      expect(await pendingChanges(alice)).toEqual({ "a.txt": "Deleted" });
      expect(await fullRescan(alice)).toEqual({ "a.txt": "Deleted" });
    });

    it("shows a renamed tracked file as the old name deleted and the new one local", async () => {
      const alice = await tracked();
      await rename(fileIn(alice, "a.txt"), fileIn(alice, "c.txt"));
      // fs.watch reports a rename as two "rename" events, one per name.
      await event(alice, "rename", "a.txt");
      await event(alice, "rename", "c.txt");
      const incremental = await pendingChanges(alice);
      expect(incremental).toEqual({ "a.txt": "Deleted", "c.txt": "Local" });
      expect(await fullRescan(alice)).toEqual(incremental);
    });

    it("shows every tracked file under a deleted directory from the directory's event alone", async () => {
      const { alice } = scene!;
      await put(alice, "dir/x.txt", "x\n");
      await put(alice, "dir/sub/y.txt", "y\n");
      await put(alice, "keep.txt", "k\n");
      await submit(alice, ["dir/x.txt", "dir/sub/y.txt", "keep.txt"]);
      installSilentWatcher(alice);
      expect(await pendingChanges(alice)).toEqual({});

      await rm(fileIn(alice, "dir"), { recursive: true });
      await event(alice, "rename", "dir");
      const incremental = await pendingChanges(alice);
      expect(incremental).toEqual({
        "dir/x.txt": "Deleted",
        "dir/sub/y.txt": "Deleted",
      });
      expect(await fullRescan(alice)).toEqual(incremental);
    });

    it("shows a new untracked directory as one entry from the directory's event alone", async () => {
      const alice = await tracked();
      await mkdir(fileIn(alice, "Saved/Config"), { recursive: true });
      await writeFile(fileIn(alice, "Saved/Config/game.ini"), "ini\n");
      await event(alice, "rename", "Saved");
      const incremental = await pendingChanges(alice);
      expect(incremental).toEqual({ Saved: "Local" });
      expect(await fullRescan(alice)).toEqual(incremental);
    });

    it("drops a pending entry when the change is undone", async () => {
      const alice = await tracked();
      await put(alice, "new.txt", "n\n");
      await event(alice, "rename", "new.txt");
      expect(await pendingChanges(alice)).toEqual({ "new.txt": "Local" });
      await rm(fileIn(alice, "new.txt"));
      await event(alice, "rename", "new.txt");
      expect(await pendingChanges(alice)).toEqual({});
    });
  });

  describe("a burst of events (a build)", () => {
    it("ends with the right list after many repeated events for a few files", async () => {
      const { alice } = scene!;
      const names = Array.from({ length: 50 }, (_, i) => `src/f${i}.cpp`);
      for (const n of names) await put(alice, n, `${n}\n`);
      await submit(alice, ["src"]);
      installSilentWatcher(alice);
      expect(await pendingChanges(alice)).toEqual({});

      // Every other file edited; each one reported many times, out of order,
      // with events for the untouched ones mixed in.
      const edited = names.filter((_, i) => i % 2 === 0);
      for (const n of edited) await put(alice, n, `${n} edited\n`);
      for (let round = 0; round < 20; round++) {
        for (const n of [...names].reverse()) await event(alice, "change", n);
        await event(alice, "change", "src");
      }
      expect(dirty(alice).length).toBe(names.length + 1);
      const incremental = await pendingChanges(alice);
      expect(incremental).toEqual(
        Object.fromEntries(edited.map((n) => [n, "ChangedNotCheckedOut"])),
      );
      expect(await fullRescan(alice)).toEqual(incremental);
    });

    it("falls back to a full rescan past the incremental threshold", async () => {
      const alice = await tracked();
      await put(alice, "a.txt", "edited, unreported\n");
      // More distinct paths than an incremental refresh takes on (5000).
      for (let i = 0; i < 5001; i++) {
        await event(alice, "rename", `gen/out${i}.tmp`);
      }
      // The full rescan finds the unreported edit too.
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });

    it("keeps a build into an ignored directory from overflowing the dirty set", async () => {
      const { alice } = scene!;
      await put(alice, ".chkignore", "Intermediate/\n");
      await put(alice, "a.txt", "a\n");
      await submit(alice, [".chkignore", "a.txt"]);
      await manager().scanIgnoreFiles(ws(alice));
      installSilentWatcher(alice);
      expect(await pendingChanges(alice)).toEqual({});

      for (let i = 0; i < 6000; i++) {
        await event(alice, "change", `Intermediate/Build/obj${i}.o`);
      }
      await put(alice, "a.txt", "edited\n");
      await event(alice, "change", "a.txt");
      expect(dirty(alice)).toEqual(["a.txt"]);
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });
  });

  describe("watcher failures", () => {
    it("drops the cache on a watcher error, and the watcher comes back", async () => {
      const alice = await tracked();
      DaemonManager.watcherRetryMs = 20;
      await put(alice, "a.txt", "edited while the watcher failed\n");
      manager().handleWatchError(
        ws(alice),
        new Error("ENOSPC: System limit for number of file watchers reached"),
      );
      expect(manager().isWatching(alice.workspace.id)).toBe(false);
      expect(daemonLog.some((l) => l.includes("Watcher error"))).toBe(true);
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });

      await waitFor("the watcher to restart", () =>
        manager().isWatching(alice.workspace.id),
      );
      // The restarted watcher is a real one: it reports the next edit.
      await put(alice, "b.txt", "edited after the restart, much longer\n");
      await waitFor(
        "b.txt to show as pending",
        async () => "b.txt" in (await pendingChanges(alice)),
      );
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
        "b.txt": "ChangedNotCheckedOut",
      });
    });

    it("does not trust the cache between a watcher error and the restart", async () => {
      // The error dropped the cache, but the next refresh rebuilt it while
      // no watcher ran, and later refreshes returned that rebuilt list: an
      // edit made before the restart stayed hidden after it.
      const alice = await tracked();
      DaemonManager.watcherRetryMs = 60_000;
      manager().handleWatchError(ws(alice), new Error("EMFILE"));
      expect(await pendingChanges(alice)).toEqual({});
      await put(alice, "a.txt", "edited while no watcher ran\n");
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });

    it("drops the cache when a watcher starts, for changes made before it did", async () => {
      const alice = await tracked();
      internals().watchers.delete(alice.workspace.id);
      expect(await pendingChanges(alice)).toEqual({});
      await put(alice, "a.txt", "edited before the watcher started\n");
      expect(manager().watchWorkspace(ws(alice))).toBe(true);
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });

    it("does not restart the watcher of a workspace unlinked in the meantime", async () => {
      const alice = await tracked();
      DaemonManager.watcherRetryMs = 20;
      manager().handleWatchError(ws(alice), new Error("ENOSPC"));
      expect(internals().watcherRetries.has(alice.workspace.id)).toBe(true);
      await detachSeat(alice);
      expect(internals().watcherRetries.has(alice.workspace.id)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(manager().isWatching(alice.workspace.id)).toBe(false);
    });

    it("keeps retrying while the workspace directory is missing", async () => {
      const alice = await tracked();
      DaemonManager.watcherRetryMs = 10;
      // The directory goes away (a drive unplugged, a folder moved). Renaming
      // it is refused on Windows while the state database is open, so point
      // the workspace somewhere missing instead.
      const realPath = alice.workspace.localPath;
      alice.workspace.localPath = `${realPath}-missing`;
      try {
        manager().handleWatchError(ws(alice), new Error("ENOENT"));
        // The first attempts find no directory and schedule more.
        await waitFor("a failed restart", () =>
          daemonLog.some((l) => l.includes("skipping watch")),
        );
        expect(manager().isWatching(alice.workspace.id)).toBe(false);
        expect(internals().watcherRetries.has(alice.workspace.id)).toBe(true);
      } finally {
        alice.workspace.localPath = realPath;
      }
      await waitFor("the watcher to restart", () =>
        manager().isWatching(alice.workspace.id),
      );
    });

    it("ignores an error from a watcher that was already replaced", async () => {
      const alice = await tracked();
      internals().watchers.delete(alice.workspace.id);
      expect(manager().watchWorkspace(ws(alice))).toBe(true);
      const first = internals().watchers.get(
        alice.workspace.id,
      ) as EventEmitter;
      expect(manager().watchWorkspace(ws(alice))).toBe(true);
      const second = internals().watchers.get(alice.workspace.id);
      expect(second).not.toBe(first);

      expect(await pendingChanges(alice)).toEqual({});
      first.emit("error", new Error("late error from the closed watcher"));
      expect(internals().watchers.get(alice.workspace.id)).toBe(second);
      expect(manager().workspacePendingChanges.has(alice.workspace.id)).toBe(
        true,
      );
    });

    it("turns an error event on the running watcher into a restart", async () => {
      const alice = await tracked();
      DaemonManager.watcherRetryMs = 20;
      internals().watchers.delete(alice.workspace.id);
      manager().watchWorkspace(ws(alice));
      const first = internals().watchers.get(
        alice.workspace.id,
      ) as EventEmitter;
      first.emit("error", new Error("EPERM"));
      expect(manager().isWatching(alice.workspace.id)).toBe(false);
      await waitFor("the watcher to restart", () =>
        manager().isWatching(alice.workspace.id),
      );
      expect(internals().watchers.get(alice.workspace.id)).not.toBe(first);
    });
  });

  describe("without a watcher", () => {
    it("rescans on every refresh, since nothing reports changes", async () => {
      const alice = await tracked();
      internals().watchers.delete(alice.workspace.id);
      expect(await pendingChanges(alice)).toEqual({});
      await put(alice, "a.txt", "edited with no watcher\n");
      expect(await pendingChanges(alice)).toEqual({
        "a.txt": "ChangedNotCheckedOut",
      });
    });
  });

  describe("the real fs.watch", () => {
    async function watched(): Promise<Seat> {
      const { alice } = scene!;
      await put(alice, "a.txt", "a\n");
      await put(alice, "dir/b.txt", "b\n");
      await submit(alice, ["a.txt", "dir/b.txt"]);
      expect(manager().watchWorkspace(ws(alice))).toBe(true);
      expect(await pendingChanges(alice)).toEqual({});
      return alice;
    }

    it("reports an edit, a new file in a new directory, and a delete", async () => {
      const alice = await watched();
      await put(alice, "a.txt", "edited for real\n");
      await put(alice, "New/Sub/c.txt", "c\n");
      await rm(fileIn(alice, "dir/b.txt"));
      const expected = {
        "a.txt": "ChangedNotCheckedOut",
        New: "Local",
        "dir/b.txt": "Deleted",
      };
      await waitFor("the changes to show as pending", async () =>
        isDeepStrictEqual(await pendingChanges(alice), expected),
      );
      expect(await fullRescan(alice)).toEqual(expected);
    });

    it("does not dirty anything for the daemon's own writes under .checkpoint", async () => {
      const alice = await watched();
      await writeFile(fileIn(alice, ".checkpoint/scratch.txt"), "daemon\n");
      await put(alice, "a.txt", "edited for real, as a marker\n");
      // Wait until the marker arrives; the .checkpoint write came first.
      await waitFor("the marker event", () => dirty(alice).includes("a.txt"));
      expect(dirty(alice).filter((p) => p.startsWith(".checkpoint"))).toEqual(
        [],
      );
    });
  });
});
