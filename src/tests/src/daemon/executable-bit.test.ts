/**
 * Marking a file executable for its next submit (pending.setExecutable), as
 * git's `update-index --chmod=+x` does. On Linux and macOS it changes the
 * file's own mode. Windows has no executable bit, so the daemon keeps the
 * mode in the workspace state and sends it with the file's next submit,
 * which is the only way to mark a file executable from Windows.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts). The fake addon
 * records the modes it is sent (lastSubmit).
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
import {
  fileIn,
  lastSubmit,
  makeScene,
  pendingChanges,
  pendingEntry,
  put,
  resetStack,
  revert,
  setExecutable,
  stageAndSubmit,
  tearDownScene,
  type Scene,
} from "../harness/stack";

const windows = process.platform === "win32";

const sentMode = (relativePath: string) =>
  lastSubmit.modifications?.find((m) => m.path === relativePath) as
    | { mode?: number }
    | undefined;

describe("marking a file executable", { timeout: 120_000 }, () => {
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

  it("shows a tracked file as modified until it is submitted executable", async () => {
    const { alice } = scene!;
    await put(alice, "tools/build.sh", "#!/bin/sh\n");
    await stageAndSubmit(alice, ["tools/build.sh"]);

    const { files } = await setExecutable(alice, ["tools/build.sh"], true);
    expect(files).toEqual([{ path: "tools/build.sh", mode: 0o755 }]);
    expect(await pendingEntry(alice, "tools/build.sh")).toEqual({
      status: "ChangedNotCheckedOut",
      executableChange: true,
    });
    if (windows) {
      expect(
        (await getWorkspaceState(alice.root, "sqlite")).pendingModes,
      ).toEqual({ "tools/build.sh": 0o755 });
    } else {
      expect((await fsp.stat(fileIn(alice, "tools/build.sh"))).mode & 0o777).toBe(
        0o755,
      );
    }

    await stageAndSubmit(alice, ["tools/build.sh"]);
    if (windows) expect(sentMode("tools/build.sh")?.mode).toBe(0o755);
    const state = await getWorkspaceState(alice.root, "sqlite");
    expect(state.files["tools/build.sh"]?.mode).toBe(0o755);
    expect(state.pendingModes).toBeUndefined();
    expect(await pendingChanges(alice)).toEqual({});
  });

  it("keeps the file executable through later edits", async () => {
    const { alice } = scene!;
    await put(alice, "run.sh", "#!/bin/sh\n");
    await stageAndSubmit(alice, ["run.sh"]);
    await setExecutable(alice, ["run.sh"], true);
    await stageAndSubmit(alice, ["run.sh"]);

    await put(alice, "run.sh", "#!/bin/sh\necho edited\n");
    await stageAndSubmit(alice, ["run.sh"]);
    if (windows) expect(sentMode("run.sh")?.mode).toBe(0o755);
    expect(
      (await getWorkspaceState(alice.root, "sqlite")).files["run.sh"]?.mode,
    ).toBe(0o755);
  });

  it("can mark a new file executable before its first submit", async () => {
    const { alice } = scene!;
    await put(alice, "new.sh", "#!/bin/sh\n");
    await setExecutable(alice, ["new.sh"], true);

    await stageAndSubmit(alice, ["new.sh"]);
    if (windows) expect(sentMode("new.sh")?.mode).toBe(0o755);
    expect(
      (await getWorkspaceState(alice.root, "sqlite")).files["new.sh"]?.mode,
    ).toBe(0o755);
  });

  it("takes the executable bit off again", async () => {
    const { alice } = scene!;
    await put(alice, "once.sh", "#!/bin/sh\n");
    await setExecutable(alice, ["once.sh"], true);
    await stageAndSubmit(alice, ["once.sh"]);

    await setExecutable(alice, ["once.sh"], false);
    expect(await pendingEntry(alice, "once.sh")).toEqual({
      status: "ChangedNotCheckedOut",
      executableChange: false,
    });
    await stageAndSubmit(alice, ["once.sh"]);
    if (windows) expect(sentMode("once.sh")?.mode).toBe(0o644);
    expect(
      (await getWorkspaceState(alice.root, "sqlite")).files["once.sh"]?.mode,
    ).toBe(0o644);
  });

  it("leaves nothing pending when set and then unset", async () => {
    const { alice } = scene!;
    await put(alice, "flip.sh", "#!/bin/sh\n");
    await stageAndSubmit(alice, ["flip.sh"]);

    await setExecutable(alice, ["flip.sh"], true);
    await setExecutable(alice, ["flip.sh"], false);
    expect(await pendingChanges(alice)).toEqual({});
    expect(
      (await getWorkspaceState(alice.root, "sqlite")).pendingModes,
    ).toBeUndefined();
  });

  it("forgets the change when the file is reverted", async () => {
    const { alice } = scene!;
    await put(alice, "undo.sh", "#!/bin/sh\n");
    await stageAndSubmit(alice, ["undo.sh"]);

    await setExecutable(alice, ["undo.sh"], true);
    await revert(alice, ["undo.sh"]);
    expect(await pendingChanges(alice)).toEqual({});
    expect(
      (await getWorkspaceState(alice.root, "sqlite")).pendingModes,
    ).toBeUndefined();
  });

  it("refuses a path that is not a file in the workspace", async () => {
    const { alice } = scene!;
    await put(alice, "dir/a.txt", "a\n");
    await expect(setExecutable(alice, ["missing.sh"], true)).rejects.toThrow(
      /not a file/,
    );
    await expect(setExecutable(alice, ["dir"], true)).rejects.toThrow(
      /not a file/,
    );
    await expect(setExecutable(alice, ["../outside.sh"], true)).rejects.toThrow();
  });
});
