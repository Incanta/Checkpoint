/**
 * File names the scan finds that cannot be submitted. Linux and macOS allow
 * almost any name, and a backslash there is part of the name, while the
 * server and every Windows client read it as a separator. One such file must
 * not fail the whole scan (and with it every submit); it is listed as
 * unsupported and never staged. Moved here from the data-loss red team
 * (Backslash).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts).
 */
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
  toRelativeRepoPath,
  unsupportedNameReason,
} from "../../../core/daemon/src/util/workspace-path.js";
import {
  contentAtHead,
  makeScene,
  pathsAtHead,
  pendingChanges,
  put,
  resetStack,
  stageAndSubmit,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

const windows = process.platform === "win32";

describe("unsupportedNameReason", () => {
  it("refuses a backslash only where it is part of a name", () => {
    expect(
      unsupportedNameReason("C:\\Users\\bob\\build.log", "linux"),
    ).not.toBeNull();
    expect(unsupportedNameReason("a\\b", "darwin")).not.toBeNull();
    expect(unsupportedNameReason("a\\b", "win32")).toBeNull();
  });

  it("refuses control characters everywhere", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(unsupportedNameReason("line\nbreak.txt", platform)).not.toBeNull();
      expect(unsupportedNameReason("tab\there", platform)).not.toBeNull();
    }
  });

  it("accepts ordinary names", () => {
    expect(unsupportedNameReason("hero.uasset", "linux")).toBeNull();
    expect(unsupportedNameReason("standup 10:15.txt", "linux")).toBeNull();
    expect(
      unsupportedNameReason("caf\u00e9 \u{1f3ae}.txt", "linux"),
    ).toBeNull();
  });

  it("turns separators into slashes only on Windows", () => {
    expect(toRelativeRepoPath(["a", "b.txt"].join(windows ? "\\" : "/"))).toBe(
      "a/b.txt",
    );
  });
});

// Each test runs two daemons' worth of submits and pulls (and the Windows
// lock tests start a PowerShell), which hosted runners can take well past the
// suite's default timeout on.
describe("odd file names in the scan", { timeout: 120_000 }, () => {
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

  it.skipIf(windows)(
    "still submits other changes when a stray file's name contains a backslash",
    async () => {
      // A script written for Windows, run on Linux or macOS, creates
      // "C:\Users\bob\build.log" as one file in the workspace root.
      const { alice, bob } = scene!;
      await put(alice, "notes.txt", "v1\n");
      await stageAndSubmit(alice, ["notes.txt"]);
      await syncLatest(bob);

      await put(bob, "C:\\Users\\bob\\build.log", "log\n");
      await put(bob, "notes.txt", "v2 from bob\n");
      await stageAndSubmit(bob, ["notes.txt"]);

      expect(
        await contentAtHead(testDb.client, scene!.repoId, "main", "notes.txt"),
      ).toBe("v2 from bob\n");
    },
  );

  it.skipIf(windows)(
    "never submits a file whose name contains a backslash, even when its folder is staged",
    async () => {
      const { bob } = scene!;
      await put(bob, "Logs/C:\\temp\\build.log", "log\n");
      await put(bob, "Logs/ok.log", "fine\n");
      expect(Object.keys(await pendingChanges(bob))).toEqual(["Logs"]);

      await stageAndSubmit(bob, ["Logs"]);

      expect(await pathsAtHead(testDb.client, scene!.repoId, "main")).toEqual([
        "Logs/ok.log",
      ]);
    },
  );

  it.skipIf(windows)(
    "lists a file with a control character in its name as unsupported, and keeps scanning",
    async () => {
      const { alice, bob } = scene!;
      await put(alice, "notes.txt", "v1\n");
      await stageAndSubmit(alice, ["notes.txt"]);
      await syncLatest(bob);
      await put(bob, "notes.txt", "v2 from bob\n");
      await put(bob, "a\nb.txt", "a newline in its name\n");

      expect(await pendingChanges(bob)).toHaveProperty(
        "notes.txt",
        expect.stringMatching(/^Changed/),
      );
      expect(await pendingChanges(bob)).not.toHaveProperty("a\nb.txt");
    },
  );
});
