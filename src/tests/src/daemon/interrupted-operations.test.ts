/**
 * Pulls and submits cut off partway: the daemon crashes, the machine reboots
 * for an update, the disk fills up. A pull records itself in the workspace
 * state before its first write and lists its backups in a journal, so a pull
 * that died is put right when the daemon next starts (interrupted-pull.ts).
 *
 * A crash is simulated by a fake native pass that writes its files and then
 * never returns, followed by unregistering the workspace and registering it
 * again, which is what a daemon start does.
 */
import { promises as fsp } from "node:fs";
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
import { getWorkspaceState } from "../../../core/daemon/src/util/util.js";
import { markPullRunning } from "../../../core/daemon/src/util/interrupted-pull.js";
import {
  contentAtHead,
  detachSeat,
  makeScene,
  overrides,
  pendingChanges,
  put,
  read,
  resetStack,
  stageAndSubmit,
  survives,
  syncLatest,
  tearDownScene,
  type Scene,
  type Seat,
} from "../harness/stack";

const state = (seat: Seat) => getWorkspaceState(seat.root, "sqlite");

/** What a daemon start does for a workspace, after its process died. */
async function restartDaemon(seat: Seat): Promise<void> {
  const record = (await state(seat)).interruptedPull;
  // The pull that "died" ran in this test process; a new process would not
  // know about it.
  if (record) markPullRunning(record.backupRoot, false);
  await detachSeat(seat);
  closeAllStateStores();
  const { DaemonManager } =
    await import("../../../core/daemon/src/daemon-manager.js");
  await DaemonManager.Get().registerWorkspace(seat.workspace as never, {
    watch: false,
  });
}

/** Makes the next native pass write its files and then hang, like a crash. */
function crashDuringNextPull(): Promise<void> {
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => (reached = resolve));
  overrides.duringPull = () => {
    reached();
    return new Promise<void>(() => {});
  };
  return hit;
}

describe("interrupted pulls and submits", { timeout: 120_000 }, () => {
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
   * Alice changes notes.txt (line 3), b.txt, and adds c.txt. Bob has his own
   * edit to notes.txt (line 1), and an untracked c.txt of his own.
   */
  async function setUp() {
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "one\ntwo\nthree\n");
    await put(alice, "b.txt", "b1\n");
    await stageAndSubmit(alice, ["notes.txt", "b.txt"]);
    await syncLatest(bob);

    await put(alice, "notes.txt", "one\ntwo\nthree, by alice\n");
    await put(alice, "b.txt", "b2\n");
    await put(alice, "c.txt", "alice's c\n");
    await stageAndSubmit(alice, ["notes.txt", "b.txt", "c.txt"]);

    await put(bob, "notes.txt", "one, by bob\ntwo\nthree\n");
    await put(bob, "c.txt", "bob's notes\n");
  }

  it("puts local edits back after a pull that died partway, and finishes on the next pull", async () => {
    const { bob } = scene!;
    await setUp();

    const hit = crashDuringNextPull();
    void syncLatest(bob).catch(() => {});
    await hit;

    // The native pass wrote the incoming versions over Bob's files.
    expect(await read(bob, "notes.txt")).toBe("one\ntwo\nthree, by alice\n");
    expect(await read(bob, "c.txt")).toBe("alice's c\n");
    expect((await state(bob)).interruptedPull).toBeDefined();

    delete overrides.duringPull;
    await restartDaemon(bob);

    expect(await read(bob, "notes.txt")).toBe("one, by bob\ntwo\nthree\n");
    expect(await read(bob, "c.txt")).toBe("bob's notes\n");
    expect((await state(bob)).interruptedPull?.restoredAt).toBeDefined();

    // b.txt holds what the dead pull wrote, against the old baseline: it
    // looks like an edit, so submitting waits for a pull.
    await expect(stageAndSubmit(bob, ["notes.txt"])).rejects.toThrow(
      /did not finish/,
    );

    await syncLatest(bob);
    expect(await read(bob, "notes.txt")).toBe(
      "one, by bob\ntwo\nthree, by alice\n",
    );
    expect(await read(bob, "b.txt")).toBe("b2\n");
    expect(await survives(bob, "c.txt", "bob's notes")).toBe(true);
    expect((await state(bob)).interruptedPull).toBeUndefined();
    expect(await pendingChanges(bob)).toEqual({
      "notes.txt": expect.any(String),
    });

    await stageAndSubmit(bob, ["notes.txt"]);
    expect(
      await contentAtHead(testDb.client, scene!.repoId, "main", "notes.txt"),
    ).toBe("one, by bob\ntwo\nthree, by alice\n");
  });

  it("recovers a pull that died before it backed anything up", async () => {
    const { alice, bob } = scene!;
    await put(alice, "b.txt", "b1\n");
    await stageAndSubmit(alice, ["b.txt"]);
    await syncLatest(bob);
    await put(alice, "b.txt", "b2\n");
    await stageAndSubmit(alice, ["b.txt"]);

    const hit = crashDuringNextPull();
    void syncLatest(bob).catch(() => {});
    await hit;
    delete overrides.duringPull;
    await restartDaemon(bob);

    expect((await state(bob)).interruptedPull?.restoredAt).toBeDefined();
    await syncLatest(bob);
    expect(await read(bob, "b.txt")).toBe("b2\n");
    expect(await pendingChanges(bob)).toEqual({});
    expect((await state(bob)).interruptedPull).toBeUndefined();
  });

  it("does not pull over a local edit it could not put back yet", async () => {
    const { bob } = scene!;
    await setUp();

    const hit = crashDuringNextPull();
    void syncLatest(bob).catch(() => {});
    await hit;
    delete overrides.duringPull;

    // notes.txt is open in an editor that will not let it be written.
    const copyFile = fsp.copyFile.bind(fsp);
    const locked = vi
      .spyOn(fsp, "copyFile")
      .mockImplementation(async (src, dest, mode) => {
        if (path.basename(String(dest)) === "notes.txt" && !String(dest).includes("pull-backups")) {
          throw Object.assign(new Error("EBUSY: resource busy or locked"), {
            code: "EBUSY",
          });
        }
        return copyFile(src, dest, mode);
      });
    await restartDaemon(bob);

    expect(await read(bob, "c.txt")).toBe("bob's notes\n");
    expect((await state(bob)).interruptedPull?.restoredAt).toBeUndefined();
    await expect(syncLatest(bob)).rejects.toThrow(/could not be put back/);

    locked.mockRestore();
    await syncLatest(bob);
    expect(await read(bob, "notes.txt")).toBe(
      "one, by bob\ntwo\nthree, by alice\n",
    );
    expect((await state(bob)).interruptedPull).toBeUndefined();
  });

  it("refuses submits after a pull that failed until one completes", async () => {
    const { bob } = scene!;
    await setUp();
    await put(bob, "d.txt", "bob's new file\n");

    overrides.duringPull = async () => {
      throw new Error("connection reset");
    };
    await expect(syncLatest(bob)).rejects.toThrow(/connection reset/);
    expect(await read(bob, "notes.txt")).toBe("one, by bob\ntwo\nthree\n");
    expect(await read(bob, "c.txt")).toBe("bob's notes\n");
    expect((await state(bob)).interruptedPull?.restoredAt).toBeDefined();

    await expect(stageAndSubmit(bob, ["d.txt"])).rejects.toThrow(
      /did not finish/,
    );

    delete overrides.duringPull;
    await syncLatest(bob);
    await stageAndSubmit(bob, ["d.txt"]);
    expect(
      await contentAtHead(testDb.client, scene!.repoId, "main", "d.txt"),
    ).toBe("bob's new file\n");
  });

  it("stops before writing anything when the disk is too full to back up an edit", async () => {
    const { bob } = scene!;
    await setUp();

    const copyFile = fsp.copyFile.bind(fsp);
    const full = vi
      .spyOn(fsp, "copyFile")
      .mockImplementation(async (src, dest, mode) => {
        if (String(dest).includes("pull-backups")) {
          throw Object.assign(new Error("ENOSPC: no space left on device"), {
            code: "ENOSPC",
          });
        }
        return copyFile(src, dest, mode);
      });
    await expect(syncLatest(bob)).rejects.toThrow(/ENOSPC/);
    full.mockRestore();

    expect(await read(bob, "notes.txt")).toBe("one, by bob\ntwo\nthree\n");
    expect(await read(bob, "b.txt")).toBe("b1\n");
    expect(await read(bob, "c.txt")).toBe("bob's notes\n");
    // Nothing was written, so nothing needs a pull before submitting.
    expect((await state(bob)).interruptedPull).toBeUndefined();

    await syncLatest(bob);
    expect(await read(bob, "notes.txt")).toBe(
      "one, by bob\ntwo\nthree, by alice\n",
    );
  });

  it("settles a submit the server recorded but the daemon never did", async () => {
    const { alice, bob } = scene!;
    await put(alice, "b.txt", "b1\n");
    await stageAndSubmit(alice, ["b.txt"]);
    await syncLatest(bob);

    await put(bob, "b.txt", "b2, by bob\n");
    // The connection drops after the server records the changelist, before
    // the daemon records it in the workspace state.
    overrides.procedures = {
      file: {
        getFileIds: () => {
          throw new Error("connection reset");
        },
      },
    };
    await expect(stageAndSubmit(bob, ["b.txt"])).rejects.toThrow(
      /connection reset/,
    );
    delete overrides.procedures;
    expect(
      await contentAtHead(testDb.client, scene!.repoId, "main", "b.txt"),
    ).toBe("b2, by bob\n");

    await syncLatest(bob);
    expect(await read(bob, "b.txt")).toBe("b2, by bob\n");
    expect(await pendingChanges(bob)).toEqual({});
    expect(await survives(bob, "b.txt", "b2, by bob")).toBe(true);
  });
});
