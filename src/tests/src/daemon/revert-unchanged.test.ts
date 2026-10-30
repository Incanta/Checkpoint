/**
 * "Revert if Unchanged" (pending.revertUnchanged), as Perforce's
 * `p4 revert -a`: a pending change whose content is identical to the version
 * it is tracked at stops being a pending change and its claim is released.
 * Anything that differs is left alone, so it never discards work.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts).
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
import { writeStagedBlob } from "../../../core/daemon/src/util/staged-blobs.js";
import {
  daemonApi,
  fileIn,
  makeScene,
  pendingChanges,
  put,
  read,
  resetStack,
  seatIds,
  setExecutable,
  stage,
  stageAndSubmit,
  tearDownScene,
  type Scene,
  type Seat,
} from "../harness/stack";

async function revertUnchanged(seat: Seat, paths?: string[]) {
  const daemon = await daemonApi();
  return daemon.workspaces.pending.revertUnchanged({
    ...seatIds(seat),
    filePaths: paths,
  });
}

async function checkout(seat: Seat, relativePath: string) {
  const daemon = await daemonApi();
  await daemon.workspaces.pending.checkout({
    ...seatIds(seat),
    path: relativePath,
  });
}

/**
 * Writes a file dated an hour ago. Submitting a file written moments earlier
 * hashes it (it is racily clean, see stampBaselines), but a pulled file
 * usually has no hash recorded, which is the case this feature settles.
 */
async function putOld(seat: Seat, relativePath: string, content: string) {
  await put(seat, relativePath, content);
  const earlier = new Date(Date.now() - 3_600_000);
  await fsp.utimes(fileIn(seat, relativePath), earlier, earlier);
}

/** Rewrites a file with the same bytes, so only its mtime changes. */
async function touchWithSameContent(seat: Seat, relativePath: string) {
  const content = await fsp.readFile(fileIn(seat, relativePath));
  const later = new Date(Date.now() + 60_000);
  await fsp.writeFile(fileIn(seat, relativePath), content);
  await fsp.utimes(fileIn(seat, relativePath), later, later);
}

describe("revert if unchanged", { timeout: 120_000 }, () => {
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

  it("reverts a file rewritten with identical content", async () => {
    const { alice } = scene!;
    await putOld(alice, "same.txt", "hello\n");
    await stageAndSubmit(alice, ["same.txt"]);

    await touchWithSameContent(alice, "same.txt");
    expect(await pendingChanges(alice)).toEqual({
      "same.txt": "ChangedNotCheckedOut",
    });

    const { reverted, kept } = await revertUnchanged(alice, ["same.txt"]);
    expect(reverted).toEqual(["same.txt"]);
    expect(kept).toEqual([]);
    expect(await pendingChanges(alice)).toEqual({});
    expect(await read(alice, "same.txt")).toBe("hello\n");
  });

  it("records the hash it computed, so the file stays unchanged", async () => {
    const { alice } = scene!;
    await putOld(alice, "hashed.txt", "content\n");
    await stageAndSubmit(alice, ["hashed.txt"]);
    await touchWithSameContent(alice, "hashed.txt");

    await revertUnchanged(alice, ["hashed.txt"]);
    const state = await getWorkspaceState(alice.root, "sqlite");
    expect(state.files["hashed.txt"]?.md5).toMatch(/^[0-9a-f]{32}$/);

    // A second identical rewrite is now settled by the hash alone.
    await touchWithSameContent(alice, "hashed.txt");
    expect(await pendingChanges(alice)).toEqual({});
  });

  it("keeps a file whose content differs, even at the same size", async () => {
    const { alice } = scene!;
    await put(alice, "edit.txt", "aaaa\n");
    await stageAndSubmit(alice, ["edit.txt"]);
    await put(alice, "edit.txt", "bbbb\n");
    await put(alice, "longer.txt", "x\n");
    await stageAndSubmit(alice, ["longer.txt"]);
    await put(alice, "longer.txt", "x and more\n");

    const { reverted, kept } = await revertUnchanged(alice, [
      "edit.txt",
      "longer.txt",
    ]);
    expect(reverted).toEqual([]);
    expect(kept).toEqual([
      { filePath: "edit.txt", reason: "Content differs" },
      { filePath: "longer.txt", reason: "Content differs" },
    ]);
    expect(await read(alice, "edit.txt")).toBe("bbbb\n");
    expect(await read(alice, "longer.txt")).toBe("x and more\n");
    expect(await pendingChanges(alice)).toEqual({
      "edit.txt": "ChangedNotCheckedOut",
      "longer.txt": "ChangedNotCheckedOut",
    });
  });

  it("undoes the checkout of a checked-out file that was never edited", async () => {
    const { alice } = scene!;
    await put(alice, "art.bin", Buffer.from([1, 2, 3]));
    await stageAndSubmit(alice, ["art.bin"]);

    await checkout(alice, "art.bin");
    expect(await pendingChanges(alice)).toEqual({
      "art.bin": "NotChangedCheckedOut",
    });

    const { reverted } = await revertUnchanged(alice, ["art.bin"]);
    expect(reverted).toEqual(["art.bin"]);
    expect(await pendingChanges(alice)).toEqual({});
  });

  it("unstages an identical file", async () => {
    const { alice } = scene!;
    await putOld(alice, "staged.txt", "s\n");
    await stageAndSubmit(alice, ["staged.txt"]);
    await touchWithSameContent(alice, "staged.txt");
    await stage(alice, ["staged.txt"]);

    await revertUnchanged(alice, ["staged.txt"]);
    expect(await pendingChanges(alice)).toEqual({});
    const state = await getWorkspaceState(alice.root, "sqlite");
    expect(state.staged ?? []).not.toContain("staged.txt");
  });

  it("never touches an untracked file", async () => {
    const { alice } = scene!;
    await put(alice, "new.txt", "brand new\n");

    const { reverted, kept } = await revertUnchanged(alice, ["new.txt"]);
    expect(reverted).toEqual([]);
    expect(kept).toEqual([{ filePath: "new.txt", reason: "Not tracked" }]);
    expect(await read(alice, "new.txt")).toBe("brand new\n");
    expect(await pendingChanges(alice)).toEqual({ "new.txt": "Local" });
  });

  it("keeps a deleted file deleted", async () => {
    const { alice } = scene!;
    await put(alice, "gone.txt", "g\n");
    await stageAndSubmit(alice, ["gone.txt"]);
    await fsp.rm(fileIn(alice, "gone.txt"));

    const { reverted, kept } = await revertUnchanged(alice, ["gone.txt"]);
    expect(reverted).toEqual([]);
    expect(kept).toEqual([{ filePath: "gone.txt", reason: "Deleted" }]);
    expect(await pendingChanges(alice)).toEqual({ "gone.txt": "Deleted" });
  });

  it("keeps a file with a pending executable-bit change", async () => {
    const { alice } = scene!;
    await put(alice, "run.sh", "#!/bin/sh\n");
    await stageAndSubmit(alice, ["run.sh"]);
    await setExecutable(alice, ["run.sh"], true);

    const { reverted, kept } = await revertUnchanged(alice, ["run.sh"]);
    expect(reverted).toEqual([]);
    expect(kept).toEqual([
      { filePath: "run.sh", reason: "Executable bit changed" },
    ]);
  });

  it("keeps a file with partially staged content", async () => {
    const { alice } = scene!;
    await putOld(alice, "partial.txt", "one\n");
    await stageAndSubmit(alice, ["partial.txt"]);
    await touchWithSameContent(alice, "partial.txt");
    await writeStagedBlob(alice.root, "partial.txt", "one\nstaged\n");

    const { reverted, kept } = await revertUnchanged(alice, ["partial.txt"]);
    expect(reverted).toEqual([]);
    expect(kept).toEqual([
      { filePath: "partial.txt", reason: "Partially staged" },
    ]);
  });

  it("reports a path that is not a pending change", async () => {
    const { alice } = scene!;
    await put(alice, "clean.txt", "c\n");
    await stageAndSubmit(alice, ["clean.txt"]);

    const { reverted, kept } = await revertUnchanged(alice, [
      "clean.txt",
      "missing.txt",
    ]);
    expect(reverted).toEqual([]);
    expect(kept).toEqual([
      { filePath: "clean.txt", reason: "Not a pending change" },
      { filePath: "missing.txt", reason: "Not a pending change" },
    ]);
  });

  it("with no paths, reverts every unchanged pending change and keeps the rest", async () => {
    const { alice } = scene!;
    await putOld(alice, "a.txt", "a\n");
    await putOld(alice, "b.txt", "b\n");
    await putOld(alice, "c.txt", "c\n");
    await stageAndSubmit(alice, ["a.txt", "b.txt", "c.txt"]);

    await touchWithSameContent(alice, "a.txt");
    await checkout(alice, "b.txt");
    await putOld(alice, "c.txt", "changed\n");
    await put(alice, "d.txt", "untracked\n");

    const { reverted } = await revertUnchanged(alice);
    expect(reverted.sort()).toEqual(["a.txt", "b.txt"]);
    expect(await pendingChanges(alice)).toEqual({
      "c.txt": "ChangedNotCheckedOut",
      "d.txt": "Local",
    });
  });

  it("accepts Windows separators and a leading slash", async () => {
    const { alice } = scene!;
    await putOld(alice, "dir/nested.txt", "n\n");
    await stageAndSubmit(alice, ["dir/nested.txt"]);
    await touchWithSameContent(alice, "dir/nested.txt");

    const { reverted } = await revertUnchanged(alice, ["\\dir\\nested.txt"]);
    expect(reverted).toEqual(["dir/nested.txt"]);
    expect(await pendingChanges(alice)).toEqual({});
  });
});
