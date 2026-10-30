/**
 * Tracked files that `.chkignore` or `.chkhidden` covers.
 *
 * Both refreshes pass over excluded paths without looking at them, and they
 * used to disagree about what that means for a file the repo already has:
 *
 * - The full scan reported every tracked file it did not see as deleted.
 * - The incremental one (what runs after staging, unstaging, or a watcher
 *   event) dropped excluded paths from the list. Staging also claims the
 *   file, so a newly ignored file still on disk came back as an unchanged,
 *   checked-out file ("modified"), and a deleted one vanished from the list
 *   when staged with the `.chkignore` that now excludes it.
 *
 * Now, as in git, `.chkignore` applies only to untracked files: a tracked
 * file it covers shows like any other (edited, or deleted only when gone from
 * disk), and leaving the repo takes an explicit delete. A `.chkhidden` one
 * never shows. Every incremental result here is checked against a forced
 * full rescan.
 */
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";

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
import { getFileStatus } from "../../../core/daemon/src/file-status.js";
import { FileStatus } from "../../../core/daemon/src/types/index.js";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import {
  daemonApi,
  exists,
  fileIn,
  makeScene,
  put,
  read,
  resetStack,
  seatIds,
  stage,
  stageAndSubmit,
  tearDownScene,
  type Scene,
  type Seat,
} from "../harness/stack";

const manager = () => DaemonManager.Get();

const internals = () =>
  manager() as unknown as {
    watchers: Map<string, unknown>;
    vcsOperationActive: Map<string, boolean>;
  };

const ws = (seat: Seat) => seat.workspace as never;

/** A watcher that reports nothing, so the test decides which events arrive. */
function installSilentWatcher(seat: Seat): void {
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  internals().watchers.set(seat.workspace.id, watcher);
}

const event = (seat: Seat, eventType: string, filename: string) =>
  manager().handleWatchEvent(ws(seat), eventType, filename);

const dirty = (seat: Seat) => [...manager().getDirtyFiles(seat.workspace.id)];

/** How a pending row reads: its status, and whether it is staged. */
type Row = { status: string; staged?: true };

async function rows(
  seat: Seat,
  opts: { full?: boolean } = {},
): Promise<Record<string, Row>> {
  const result = await manager().refreshWorkspaceContents(ws(seat), {
    forceFullRefresh: opts.full ?? false,
  });
  const out: Record<string, Row> = {};
  for (const [p, f] of Object.entries(result.files)) {
    out[p] = {
      status: FileStatus[f.status] ?? String(f.status),
      ...(f.staged && { staged: true as const }),
    };
  }
  return out;
}

/** The incremental result, which must match a forced full rescan. */
async function settled(seat: Seat): Promise<Record<string, Row>> {
  const incremental = await rows(seat);
  expect(await rows(seat, { full: true })).toEqual(incremental);
  return incremental;
}

async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function submit(seat: Seat, paths: string[]): Promise<void> {
  await stageAndSubmit(seat, paths);
  await waitFor(
    "the submit's VCS operation to end",
    () => !internals().vcsOperationActive.get(seat.workspace.id),
  );
}

async function unstage(seat: Seat, paths: string[]): Promise<void> {
  const daemon = await daemonApi();
  await daemon.workspaces.pending.unstage({ ...seatIds(seat), paths });
}

/** Writes `.chkignore` and reports it, as the watcher would. */
async function setIgnore(seat: Seat, content: string): Promise<void> {
  await put(seat, ".chkignore", content);
  await event(seat, "change", ".chkignore");
}

const DELETED = { status: "Deleted" } as const;
const EDITED = { status: "ChangedNotCheckedOut" } as const;
const NEW = { status: "Local" } as const;

describe("tracked files .chkignore or .chkhidden covers", { timeout: 120_000 }, () => {
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
    await tearDownScene(scene);
    closeAllStateStores();
    scene = undefined;
  });

  /** Alice with `files` submitted, a silent watcher, and a warm cache. */
  async function tracked(files: string[]): Promise<Seat> {
    const { alice } = scene!;
    for (const f of files) await put(alice, f, `${f}\n`);
    await submit(alice, files);
    installSilentWatcher(alice);
    expect(await rows(alice)).toEqual({});
    return alice;
  }

  describe("still on disk", () => {
    it("is not deleted just because a rule now covers it", async () => {
      const alice = await tracked(["test.txt", "keep.md"]);
      await setIgnore(alice, "*.txt\n");
      expect(await settled(alice)).toEqual({ ".chkignore": NEW });
    });

    it("shows an edit, from the watcher's event and from a rescan", async () => {
      const alice = await tracked(["test.txt"]);
      await setIgnore(alice, "*.txt\n");
      await settled(alice);

      await put(alice, "test.txt", "edited\n");
      await event(alice, "change", "test.txt");
      expect(dirty(alice)).toEqual(["test.txt"]);
      expect(await settled(alice)).toEqual({
        ".chkignore": NEW,
        "test.txt": EDITED,
      });
    });

    it("stages and unstages like a file no rule covers (it flipped between deleted and modified)", async () => {
      // keep.md is the control: test.txt must read exactly as it does.
      const alice = await tracked(["test.txt", "keep.md"]);
      await setIgnore(alice, "*.txt\n");
      await put(alice, "test.txt", "edited\n");
      await put(alice, "keep.md", "edited\n");
      await event(alice, "change", "test.txt");
      await event(alice, "change", "keep.md");
      const before = await settled(alice);
      expect(before["test.txt"]).toEqual(before["keep.md"]);

      await stage(alice, ["test.txt", "keep.md"]);
      let now = await settled(alice);
      expect(now["test.txt"]).toEqual(now["keep.md"]);
      expect(now["test.txt"]?.staged).toBe(true);

      await unstage(alice, ["test.txt", "keep.md"]);
      now = await settled(alice);
      expect(now["test.txt"]).toEqual(now["keep.md"]);
      expect(now["test.txt"]?.staged).toBeUndefined();

      // Editing the rules again, then staging, is where it flipped back.
      await setIgnore(alice, "*.txt\n# edited\n");
      await stage(alice, ["test.txt", "keep.md"]);
      now = await settled(alice);
      expect(now["test.txt"]).toEqual(now["keep.md"]);
    });

    it("stays in the repo when the .chkignore is submitted", async () => {
      const alice = await tracked(["test.txt"]);
      await setIgnore(alice, "*.txt\n");
      await submit(alice, [".chkignore"]);
      expect(
        manager().getWorkspaceState(alice.workspace.id)?.files["test.txt"],
      ).toBeDefined();
      expect(await rows(alice, { full: true })).toEqual({});
    });

    it("submits an edit", async () => {
      const alice = await tracked(["test.txt"]);
      await setIgnore(alice, "*.txt\n");
      await put(alice, "test.txt", "edited\n");
      await event(alice, "change", "test.txt");
      await submit(alice, [".chkignore", "test.txt"]);
      expect(await read(alice, "test.txt")).toBe("edited\n");
      expect(await rows(alice, { full: true })).toEqual({});
    });

    it("leaves the repo by an explicit delete, and is then ignored", async () => {
      const alice = await tracked(["test.txt"]);
      await setIgnore(alice, "*.txt\n");
      await rm(fileIn(alice, "test.txt"));
      await event(alice, "rename", "test.txt");
      await submit(alice, [".chkignore", "test.txt"]);
      expect(
        manager().getWorkspaceState(alice.workspace.id)?.files["test.txt"],
      ).toBeUndefined();

      // Recreated, it is untracked now, so the rule applies.
      await put(alice, "test.txt", "local only\n");
      await event(alice, "rename", "test.txt");
      expect(await settled(alice)).toEqual({});
      expect(exists(alice, "test.txt")).toBe(true);
    });

    it("covers tracked files in an ignored folder, without listing the untracked ones", async () => {
      const alice = await tracked(["Saved/a.ini", "Saved/sub/b.ini", "c.md"]);
      await setIgnore(alice, "Saved/\n");
      expect(await settled(alice)).toEqual({ ".chkignore": NEW });

      await put(alice, "Saved/sub/b.ini", "edited\n");
      await put(alice, "Saved/autosave.dat", "untracked\n");
      await event(alice, "change", "Saved/sub/b.ini");
      await event(alice, "rename", "Saved/autosave.dat");
      expect(await settled(alice)).toEqual({
        ".chkignore": NEW,
        "Saved/sub/b.ini": EDITED,
      });
    });
  });

  describe("gone from disk", () => {
    it("stays listed when staged together with the .chkignore that now covers it", async () => {
      const alice = await tracked(["test.xyz"]);
      await rm(fileIn(alice, "test.xyz"));
      await event(alice, "rename", "test.xyz");
      await setIgnore(alice, "*.xyz\n");
      expect(await settled(alice)).toEqual({
        ".chkignore": NEW,
        "test.xyz": DELETED,
      });

      await stage(alice, [".chkignore", "test.xyz"]);
      expect(await settled(alice)).toEqual({
        ".chkignore": { ...NEW, staged: true },
        "test.xyz": { ...DELETED, staged: true },
      });
    });

    it("stays listed when staged after the .chkignore, in a separate step", async () => {
      const alice = await tracked(["test.xyz"]);
      await rm(fileIn(alice, "test.xyz"));
      await event(alice, "rename", "test.xyz");
      await setIgnore(alice, "*.xyz\n");
      await stage(alice, [".chkignore"]);
      // The app refreshes after each stage, so the next one is incremental.
      await rows(alice);
      await stage(alice, ["test.xyz"]);
      expect(await rows(alice)).toEqual({
        ".chkignore": { ...NEW, staged: true },
        "test.xyz": { ...DELETED, staged: true },
      });
      expect(await settled(alice)).toEqual({
        ".chkignore": { ...NEW, staged: true },
        "test.xyz": { ...DELETED, staged: true },
      });
    });

    it("stays listed when staged together after a refresh of each step", async () => {
      const alice = await tracked(["test.xyz"]);
      await rm(fileIn(alice, "test.xyz"));
      await event(alice, "rename", "test.xyz");
      await rows(alice);
      await setIgnore(alice, "*.xyz\n");
      await rows(alice);
      await stage(alice, [".chkignore", "test.xyz"]);
      await rows(alice);
      // A second stage of the same rows (a re-drag) is incremental.
      await stage(alice, ["test.xyz"]);
      expect(await rows(alice)).toEqual({
        ".chkignore": { ...NEW, staged: true },
        "test.xyz": { ...DELETED, staged: true },
      });
    });

    it("shows when deleted after the rule already covers it", async () => {
      const alice = await tracked(["test.xyz"]);
      await setIgnore(alice, "*.xyz\n");
      await settled(alice);
      await rm(fileIn(alice, "test.xyz"));
      await event(alice, "rename", "test.xyz");
      expect(dirty(alice)).toEqual(["test.xyz"]);
      expect(await settled(alice)).toEqual({
        ".chkignore": NEW,
        "test.xyz": DELETED,
      });

      // Restored, it is unchanged again.
      await put(alice, "test.xyz", "test.xyz\n");
      await event(alice, "rename", "test.xyz");
      expect(await settled(alice)).toEqual({ ".chkignore": NEW });
    });

    it("shows every tracked file of a deleted ignored folder from the folder's event alone", async () => {
      const alice = await tracked(["Saved/a.ini", "Saved/sub/b.ini"]);
      await setIgnore(alice, "Saved/\n");
      await settled(alice);

      await rm(fileIn(alice, "Saved"), { recursive: true });
      await event(alice, "rename", "Saved");
      expect(await settled(alice)).toEqual({
        ".chkignore": NEW,
        "Saved/a.ini": DELETED,
        "Saved/sub/b.ini": DELETED,
      });
    });

    it("submits the delete together with the .chkignore", async () => {
      const alice = await tracked(["test.xyz"]);
      await rm(fileIn(alice, "test.xyz"));
      await event(alice, "rename", "test.xyz");
      await setIgnore(alice, "*.xyz\n");
      await submit(alice, [".chkignore", "test.xyz"]);
      const files = manager().getWorkspaceState(alice.workspace.id)?.files;
      expect(files?.["test.xyz"]).toBeUndefined();
      expect(files?.[".chkignore"]).toBeDefined();
      expect(await rows(alice, { full: true })).toEqual({});
    });
  });

  describe("reporting a path as ignored", () => {
    it("never reports a tracked file, as git check-ignore does not", async () => {
      const alice = await tracked(["test.txt"]);
      await setIgnore(alice, "*.txt\n");
      await put(alice, "other.txt", "untracked\n");
      expect(
        await manager().checkIgnored(ws(alice), ["test.txt", "other.txt"]),
      ).toEqual(["other.txt"]);

      const status = (relativePath: string) =>
        getFileStatus({
          workspacePath: alice.root,
          relativePath,
          workspaceState: manager().getWorkspaceState(alice.workspace.id),
          ignoreCache: manager().getIgnoreCache(alice.workspace.id),
          existsOnDisk: true,
          isDirectory: false,
        });
      expect((await status("test.txt")).status).not.toBe(FileStatus.Ignored);
      expect((await status("other.txt")).status).toBe(FileStatus.Ignored);
    });

    it("still skips watcher events for ignored files the repo does not have", async () => {
      const alice = await tracked(["a.md"]);
      await setIgnore(alice, "*.log\nIntermediate/\n");
      await settled(alice);
      await put(alice, "debug.log", "log\n");
      await put(alice, "Intermediate/obj.o", "obj\n");
      await event(alice, "rename", "debug.log");
      await event(alice, "rename", "Intermediate");
      await event(alice, "rename", "Intermediate/obj.o");
      expect(dirty(alice)).toEqual([]);
    });
  });

  describe(".chkhidden", () => {
    it("never lists a hidden tracked file, on disk or deleted", async () => {
      const alice = await tracked(["Config/Default.ini", "a.md"]);
      await put(alice, ".chkhidden", "Config/\n");
      await event(alice, "change", ".chkhidden");
      expect(await settled(alice)).toEqual({ ".chkhidden": NEW });

      await put(alice, "Config/Default.ini", "edited\n");
      await event(alice, "change", "Config/Default.ini");
      expect(await settled(alice)).toEqual({ ".chkhidden": NEW });

      await rm(fileIn(alice, "Config/Default.ini"));
      await event(alice, "rename", "Config/Default.ini");
      expect(await settled(alice)).toEqual({ ".chkhidden": NEW });
    });

    it("still hides a tracked file .chkignore covers too", async () => {
      const alice = await tracked(["Config/Default.ini"]);
      await put(alice, ".chkhidden", "Config/\n");
      await event(alice, "change", ".chkhidden");
      await setIgnore(alice, "*.ini\n");
      await put(alice, "Config/Default.ini", "edited\n");
      await event(alice, "change", "Config/Default.ini");
      expect(await settled(alice)).toEqual({
        ".chkhidden": NEW,
        ".chkignore": NEW,
      });
    });
  });
});
