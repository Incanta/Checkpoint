/**
 * Team Sync's "Clean Workspace" (src/core/daemon/src/util/team-sync/clean.ts)
 * must not be able to lose work. Whatever the workspace state still has a
 * claim on (tracked, artifact, marked-for-add, and staged files, pending
 * removals and modes, anything under .checkpoint) is never offered and never
 * touched, under any spelling the volume takes for it. Of what is cleaned,
 * only regenerable build output is deleted; every other file is moved into
 * .checkpoint/clean-backups/<stamp>/ with its content intact.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts).
 */
import { existsSync, promises as fsp } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { updateWorkspaceState } from "../../../core/daemon/src/util/util.js";
import {
  cleanExecute,
  cleanPreview,
  exists,
  fileIn,
  filesystemIsCaseInsensitive,
  makeScene,
  put,
  read,
  resetStack,
  stage,
  stageAndSubmit,
  tearDownScene,
  type Scene,
  type Seat,
} from "../harness/stack";

const caseInsensitive = await filesystemIsCaseInsensitive();

const offered = async (seat: Seat) =>
  (await cleanPreview(seat)).map((c) => c.path);

describe("Clean Workspace", { timeout: 120_000 }, () => {
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

  describe("never touches what the state still claims", () => {
    it("keeps a staged new file, even under Saved/ where it would be pre-selected", async () => {
      const { alice } = scene!;
      await put(alice, "Saved/Config/draft.ini", "work in progress\n");
      await put(alice, "notes.txt", "also staged\n");
      await stage(alice, ["Saved/Config/draft.ini", "notes.txt"]);

      expect(await offered(alice)).toEqual([]);
      const result = await cleanExecute(alice, [
        "Saved/Config/draft.ini",
        "notes.txt",
      ]);

      expect(result.deleted).toBe(0);
      expect(result.movedToBackup).toBe(0);
      expect(result.skipped.map((s) => s.path).sort()).toEqual([
        "Saved/Config/draft.ini",
        "notes.txt",
      ]);
      expect(await read(alice, "Saved/Config/draft.ini")).toBe(
        "work in progress\n",
      );
      expect(await read(alice, "notes.txt")).toBe("also staged\n");
    });

    it("keeps every file under a staged new directory", async () => {
      const { alice } = scene!;
      await put(alice, "Binaries/Tools/helper.txt", "staged as a directory\n");
      await stage(alice, ["Binaries"]);

      expect(await offered(alice)).toEqual([]);
      const result = await cleanExecute(alice, ["Binaries/Tools/helper.txt"]);
      expect(result.deleted).toBe(0);
      expect(exists(alice, "Binaries/Tools/helper.txt")).toBe(true);
    });

    it("keeps a tracked file", async () => {
      const { alice } = scene!;
      await put(alice, "Saved/tracked.txt", "submitted\n");
      await stageAndSubmit(alice, ["Saved/tracked.txt"]);

      expect(await offered(alice)).toEqual([]);
      const result = await cleanExecute(alice, ["Saved/tracked.txt"]);
      expect(result).toMatchObject({ deleted: 0, movedToBackup: 0 });
      expect(await read(alice, "Saved/tracked.txt")).toBe("submitted\n");
    });

    it("keeps a pending removal and everything under one that is a directory", async () => {
      // A pull could not delete Saved/Logs (a directory stood in its place)
      // or Saved/old.log (open in another program).
      const { alice } = scene!;
      await put(alice, "Saved/Logs/run.log", "the user's log\n");
      await put(alice, "Saved/old.log", "still open\n");
      await updateWorkspaceState(
        { localPath: alice.root },
        { meta: { pendingRemovals: ["Saved/Logs", "Saved/old.log"] } },
        "sqlite",
      );

      expect(await offered(alice)).toEqual([]);
      const result = await cleanExecute(alice, [
        "Saved/Logs/run.log",
        "Saved/old.log",
      ]);
      expect(result.skipped).toHaveLength(2);
      expect(exists(alice, "Saved/Logs/run.log")).toBe(true);
      expect(exists(alice, "Saved/old.log")).toBe(true);
    });

    it("keeps a file with a pending mode", async () => {
      const { alice } = scene!;
      await put(alice, "Binaries/run.sh", "#!/bin/sh\n");
      await updateWorkspaceState(
        { localPath: alice.root },
        { meta: { pendingModes: { "Binaries/run.sh": 0o755 } } },
        "sqlite",
      );

      expect(await offered(alice)).toEqual([]);
      await cleanExecute(alice, ["Binaries/run.sh"]);
      expect(exists(alice, "Binaries/run.sh")).toBe(true);
    });

    it("never offers or touches anything under a .checkpoint directory at any depth", async () => {
      const { alice } = scene!;
      await put(alice, ".checkpoint/x", "daemon data\n");
      await put(alice, "Plugins/Sub/.checkpoint/state.txt", "nested\n");

      expect(await offered(alice)).toEqual([]);
      const result = await cleanExecute(alice, [
        ".checkpoint/x",
        "Plugins/Sub/.checkpoint/state.txt",
      ]);
      expect(result.skipped).toHaveLength(2);
      expect(exists(alice, ".checkpoint/x")).toBe(true);
      expect(exists(alice, "Plugins/Sub/.checkpoint/state.txt")).toBe(true);
    });

    it.runIf(caseInsensitive)(
      "keeps a tracked or staged file asked for under another spelling",
      async () => {
        const { alice } = scene!;
        await put(alice, "Content/Hero.txt", "hero\n");
        await stageAndSubmit(alice, ["Content/Hero.txt"]);
        await put(alice, "Saved/Draft.txt", "draft\n");
        await stage(alice, ["Saved/Draft.txt"]);

        const result = await cleanExecute(alice, [
          "content/hero.txt",
          "CONTENT/HERO.TXT",
          "saved/draft.txt",
        ]);
        expect(result).toMatchObject({ deleted: 0, movedToBackup: 0 });
        expect(result.skipped).toHaveLength(3);
        expect(await read(alice, "Content/Hero.txt")).toBe("hero\n");
        expect(await read(alice, "Saved/Draft.txt")).toBe("draft\n");
      },
    );
  });

  describe("refuses paths it must not touch", () => {
    it("refuses paths outside the workspace and in .checkpoint", async () => {
      const { alice } = scene!;
      const outsideName = `chk-clean-outside-${Date.now()}.txt`;
      const outside = path.join(path.dirname(alice.root), outsideName);
      await fsp.writeFile(outside, "not yours\n");
      try {
        await put(alice, ".checkpoint/x", "daemon data\n");
        const result = await cleanExecute(alice, [
          `../${outsideName}`,
          `..\\${outsideName}`,
          ".checkpoint/x",
          ".CHECKPOINT/x",
          "",
        ]);
        expect(result).toMatchObject({ deleted: 0, movedToBackup: 0 });
        // Both spellings of ../ are one path once backslashes are separators.
        expect(result.skipped.map((s) => s.path)).toEqual([
          `../${outsideName}`,
          ".checkpoint/x",
          ".CHECKPOINT/x",
          "",
        ]);
        expect(existsSync(outside)).toBe(true);
        expect(exists(alice, ".checkpoint/x")).toBe(true);
      } finally {
        await rm(outside, { force: true });
      }
    });

    it("skips a directory passed as a path, leaving its files", async () => {
      const { alice } = scene!;
      await put(alice, "Stuff/a.txt", "a\n");
      await put(alice, "Saved/Logs/b.log", "b\n");

      const result = await cleanExecute(alice, [
        "Stuff",
        "Saved",
        "Saved/Logs",
      ]);
      expect(result).toMatchObject({ deleted: 0, movedToBackup: 0 });
      expect(result.skipped.map((s) => s.reason)).toEqual([
        "it is a directory",
        "it is a directory",
        "it is a directory",
      ]);
      expect(exists(alice, "Stuff/a.txt")).toBe(true);
      expect(exists(alice, "Saved/Logs/b.log")).toBe(true);
    });

    it("does not follow a linked directory out of the workspace", async () => {
      const { alice } = scene!;
      const outsideDir = await mkdtemp(path.join(tmpdir(), "chk-clean-link-"));
      try {
        await fsp.writeFile(path.join(outsideDir, "secret.txt"), "outside\n");
        await fsp.symlink(
          outsideDir,
          fileIn(alice, "Linked"),
          process.platform === "win32" ? "junction" : "dir",
        );

        expect(await offered(alice)).toEqual([]);
        const result = await cleanExecute(alice, ["Linked/secret.txt"]);
        expect(result).toMatchObject({ deleted: 0, movedToBackup: 0 });
        expect(existsSync(path.join(outsideDir, "secret.txt"))).toBe(true);
      } finally {
        await rm(fileIn(alice, "Linked"), {
          force: true,
          recursive: false,
        }).catch(() =>
          fsp.unlink(fileIn(alice, "Linked")).catch(() => undefined),
        );
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("refuses to clean while an interrupted pull is unrecovered", async () => {
      const { alice } = scene!;
      await put(alice, "notes/todo.txt", "mine\n");
      await updateWorkspaceState(
        { localPath: alice.root },
        {
          meta: {
            interruptedPull: {
              changelist: 2,
              backupRoot: path.join(
                alice.root,
                ".checkpoint",
                "pull-backups",
                "x",
              ),
              pid: 999_999,
              startedAt: new Date().toISOString(),
            },
          },
        },
        "sqlite",
      );

      await expect(cleanExecute(alice, ["notes/todo.txt"])).rejects.toThrow(
        /interrupted/,
      );
      expect(exists(alice, "notes/todo.txt")).toBe(true);
    });
  });

  describe("cleaning", () => {
    it("deletes intermediate build output outright", async () => {
      const { alice } = scene!;
      await put(alice, "Game/Intermediate/Build/obj.o", "object\n");
      await put(alice, "Game.sln", "solution\n");

      const candidates = await cleanPreview(alice);
      expect(candidates.map((c) => [c.path, c.category]).sort()).toEqual([
        ["Game.sln", "intermediate"],
        ["Game/Intermediate/Build/obj.o", "intermediate"],
      ]);

      const result = await cleanExecute(
        alice,
        candidates.map((c) => c.path),
      );
      expect(result).toEqual({
        deleted: 2,
        movedToBackup: 0,
        backupRoot: null,
        skipped: [],
      });
      expect(exists(alice, "Game/Intermediate/Build/obj.o")).toBe(false);
      expect(exists(alice, "Game.sln")).toBe(false);
      // Directories it emptied go too.
      expect(exists(alice, "Game")).toBe(false);
    });

    it("moves an untracked file into the clean backup folder with its content intact", async () => {
      const { alice } = scene!;
      const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
      await put(alice, "notes/todo.txt", "remember the milk\n");
      await put(alice, "notes/blob.bin", bytes);

      const candidates = await cleanPreview(alice);
      expect(candidates.map((c) => [c.path, c.category]).sort()).toEqual([
        ["notes/blob.bin", "untracked"],
        ["notes/todo.txt", "untracked"],
      ]);

      const result = await cleanExecute(alice, [
        "notes/todo.txt",
        "notes/blob.bin",
      ]);
      expect(result.deleted).toBe(0);
      expect(result.movedToBackup).toBe(2);
      expect(result.skipped).toEqual([]);
      expect(result.backupRoot).not.toBeNull();
      const backupRoot = result.backupRoot!;
      expect(
        path.relative(
          path.join(alice.root, ".checkpoint", "clean-backups"),
          backupRoot,
        ),
      ).toMatch(/^[0-9a-z]+$/);

      expect(exists(alice, "notes/todo.txt")).toBe(false);
      expect(exists(alice, "notes")).toBe(false);
      expect(
        await fsp.readFile(path.join(backupRoot, "notes", "todo.txt"), "utf8"),
      ).toBe("remember the milk\n");
      expect(
        await fsp.readFile(path.join(backupRoot, "notes", "blob.bin")),
      ).toEqual(bytes);

      // The backup is not offered for cleaning in turn.
      expect(await offered(alice)).toEqual([]);
    });

    it("cleans what it may from a mixed batch and reports the rest", async () => {
      const { alice } = scene!;
      await put(alice, "Saved/Logs/editor.log", "log\n");
      await put(alice, "scratch.txt", "scratch\n");
      await put(alice, "Saved/staged.txt", "staged\n");
      await stage(alice, ["Saved/staged.txt"]);

      const result = await cleanExecute(alice, [
        "Saved/Logs/editor.log",
        "scratch.txt",
        "Saved/staged.txt",
        "missing.txt",
        "../escape.txt",
      ]);
      expect(result.deleted).toBe(1);
      expect(result.movedToBackup).toBe(1);
      expect(result.skipped.map((s) => s.path).sort()).toEqual([
        "../escape.txt",
        "Saved/staged.txt",
        "missing.txt",
      ]);
      expect(exists(alice, "Saved/staged.txt")).toBe(true);
      expect(
        await fsp.readFile(
          path.join(result.backupRoot!, "scratch.txt"),
          "utf8",
        ),
      ).toBe("scratch\n");
    });
  });
});
