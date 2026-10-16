/**
 * The smaller data-loss observations from the red team (its README's "Other
 * observations"): revert keeps a file that exists nowhere else, resolving a
 * conflict needs a local change to resolve, the OS's own files are ignored,
 * and pull backups keep paths short.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts).
 */
import { existsSync } from "node:fs";
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
import { LocalChangeGuard } from "../../../core/daemon/src/util/pull-local-changes.js";
import {
  buildIgnoreCacheFromPatterns,
  isIgnoredOrHidden,
} from "../../../core/daemon/src/file-status.js";
import {
  makeScene,
  pendingChanges,
  put,
  read,
  resetStack,
  resolveConflicts,
  revert,
  stageAndSubmit,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

// Each test runs two daemons' worth of submits and pulls (and the Windows
// lock tests start a PowerShell), which hosted runners can take well past the
// suite's default timeout on.
describe("smaller observations", { timeout: 120_000 }, () => {
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

  it("keeps a locally added file on disk when its add is reverted", async () => {
    // Perforce leaves an added file in place on revert; the file exists
    // nowhere else, so deleting it lost it.
    const { bob } = scene!;
    await put(bob, "Docs/draft.txt", "a draft that exists nowhere else\n");

    await revert(bob, ["Docs/draft.txt"]);

    expect(await read(bob, "Docs/draft.txt")).toBe(
      "a draft that exists nowhere else\n",
    );
    // Untracked again (its folder is listed, as for any untracked folder).
    expect(await pendingChanges(bob)).toHaveProperty("Docs", "Local");
  });

  it("does not mark an unmodified, merely outdated file as resolved", async () => {
    // Marking it resolved would record the remote version as what is on disk
    // while disk still holds the old one; its next submit would revert the
    // remote change.
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "v1\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);
    await put(alice, "notes.txt", "v2 from alice\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    const before = (await getWorkspaceState(bob.root, "sqlite")).files[
      "notes.txt"
    ]!.changelist;

    const result = (await resolveConflicts(bob, ["notes.txt"])) as {
      resolvedPaths: string[];
      notModified: string[];
    };

    expect(result.resolvedPaths).toEqual([]);
    expect(result.notModified).toEqual(["notes.txt"]);
    expect(
      (await getWorkspaceState(bob.root, "sqlite")).files["notes.txt"]!
        .changelist,
    ).toBe(before);
    // A pull brings the remote version instead.
    await syncLatest(bob);
    expect(await read(bob, "notes.txt")).toBe("v2 from alice\n");
  });

  it("still resolves a file that has local changes", async () => {
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "v1\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);
    await put(alice, "notes.txt", "v2 from alice\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await put(bob, "notes.txt", "v2 from bob, merged by hand\n");

    const result = (await resolveConflicts(bob, ["notes.txt"])) as {
      resolvedPaths: string[];
    };
    expect(result.resolvedPaths).toEqual(["notes.txt"]);
  });

  it("ignores the files the OS writes on its own", async () => {
    const { bob } = scene!;
    await put(bob, ".DS_Store", "finder\n");
    await put(bob, "Content/._hero.uasset", "appledouble\n");
    await put(bob, "Content/Thumbs.db", "explorer\n");
    await put(bob, "Docs/desktop.ini", "explorer\n");
    await put(bob, "Docs/real.txt", "real\n");

    expect(Object.keys(await pendingChanges(bob))).toEqual(["Docs"]);
  });

  it("lets a project's ignore file take one of those back", () => {
    const negated = buildIgnoreCacheFromPatterns({
      ignore: [
        {
          absolutePath: "/ws/.chkignore",
          relativeDir: "",
          patterns: ["!Thumbs.db"],
        },
      ],
      hidden: [],
    });
    const plain = buildIgnoreCacheFromPatterns({ ignore: [], hidden: [] });
    expect(isIgnoredOrHidden(plain, "Content/Thumbs.db")).toBe(true);
    expect(isIgnoredOrHidden(negated, "Content/Thumbs.db")).toBe(false);
    expect(isIgnoredOrHidden(negated, ".DS_Store")).toBe(true);
  });

  it("keeps the pull backup folder's name short", () => {
    // Every backup path is the file's own path under this folder, and
    // Explorer and many Windows tools stop at 260 characters.
    const guard = new LocalChangeGuard(scene!.bob.root, "cl123456");
    expect(path.basename(guard.backupRoot).length).toBeLessThanOrEqual(20);
    expect(existsSync(guard.backupRoot)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "reports pulled paths that Windows tools cannot handle",
    async () => {
      const { alice, bob } = scene!;
      const long = `Content/${"a".repeat(110)}/${"b".repeat(120)}.txt`;
      await put(alice, long, "deep\n");
      await stageAndSubmit(alice, [long]);

      const result = (await syncLatest(bob)) as { longPaths?: string[] };

      expect(result.longPaths).toEqual([long]);
      expect(await read(bob, long)).toBe("deep\n");
    },
  );
});
