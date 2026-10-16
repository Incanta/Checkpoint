/**
 * Red team: what the filesystem under a workspace does to pulls, submits,
 * and cleanups on Windows, macOS, and Linux.
 *
 * Each test runs where its behavior exists and is skipped elsewhere. Case and
 * Unicode normalization are probed on the filesystem the seats live on, not
 * inferred from the OS; Windows file sharing and POSIX-only file names go by
 * platform. CI runs the suite on all three (.github/workflows/data-loss.yaml).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (see ./stack.ts). Each test states the
 * safe outcome; a failure is an open bug, written up in ./README.md.
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
  cleanExecute,
  cleanPreview,
  contentAtHead,
  describeFile,
  exists,
  fileIn,
  filesystemIsCaseInsensitive,
  filesystemIsNormalizationInsensitive,
  filesystemKeepsShortNames,
  holdOpen,
  makeScene,
  overrides,
  pathsAtHead,
  pendingChanges,
  put,
  read,
  resetStack,
  setTeamSync,
  stageAndSubmit,
  submitDirect,
  survives,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

const caseInsensitive = await filesystemIsCaseInsensitive();
const normalizationInsensitive = await filesystemIsNormalizationInsensitive();
const keepsShortNames = await filesystemKeepsShortNames();
const windows = process.platform === "win32";
// The real native include matcher, for the one test that needs it; null
// where the addon's binary cannot load.
const realFilterPaths = await vi
  .importActual<
    typeof import("@checkpointvcs/longtail-addon")
  >("@checkpointvcs/longtail-addon")
  .then(
    (addon) => addon.filterPaths,
    () => null,
  );

describe("data loss: the filesystem under the workspace", () => {
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

  /** A pending-changes status for a locally modified tracked file. */
  const stillPending = expect.stringMatching(/^Changed/);

  describe("names that are one file on Windows and macOS (case)", () => {
    it.runIf(caseInsensitive)(
      "keeps Content/Hero.txt when Content/hero.txt is deleted upstream",
      async () => {
        // Carol, on Linux, adds a second file whose name differs only in
        // case; the server accepts it (DL-08). On Bob's machine both names
        // are one file. When Carol deletes hers, Bob's pull deletes that one
        // file, and the daemon then shows Content/Hero.txt as deleted by Bob.
        const { alice, bob } = scene!;
        await put(alice, "Content/Hero.txt", "hero, as alice made it\n");
        await stageAndSubmit(alice, ["Content/Hero.txt"]);
        await submitDirect(alice, {
          write: { "Content/hero.txt": "carol's notes about the hero\n" },
        });
        await syncLatest(bob);
        await submitDirect(alice, { remove: ["Content/hero.txt"] });

        await syncLatest(bob);

        expect(
          exists(bob, "Content/Hero.txt"),
          `Content/Hero.txt is still at the head, but Bob's pull deleted it. Pending: ${JSON.stringify(
            await pendingChanges(bob),
          )}, so "submit everything" deletes it for everyone`,
        ).toBe(true);
      },
    );

    /**
     * Alice adds Content/Maps/arena.txt; Carol, on Linux, adds
     * content/maps/forest.txt. On Bob's machine both land in one
     * Content/Maps directory, so the file the state calls
     * content/maps/forest.txt sits on disk as Content/Maps/forest.txt.
     */
    async function pullDirectorySpelledTwoWays() {
      const { alice, bob } = scene!;
      await put(alice, "Content/Maps/arena.txt", "arena\n");
      await stageAndSubmit(alice, ["Content/Maps/arena.txt"]);
      await submitDirect(alice, {
        write: { "content/maps/forest.txt": "forest\n" },
      });
      await syncLatest(bob);
    }

    it.runIf(caseInsensitive)(
      "leaves nothing pending after pulling a directory the tree spells two ways",
      async () => {
        // The scan finds Content/Maps/forest.txt, which the state does not
        // know (untracked), and never finds content/maps/forest.txt, which
        // it does (deleted). "Submit everything" moves the file; reverting
        // the untracked entry deletes it from disk.
        await pullDirectorySpelledTwoWays();

        expect(await pendingChanges(scene!.bob)).toEqual({});
      },
    );

    it.runIf(caseInsensitive)(
      "does not let Clean Workspace delete a tracked file in a directory the tree spells two ways",
      async () => {
        // Clean Workspace re-checks each path against the state before it
        // deletes, by exact spelling, so the tracked file passes as untracked.
        const { bob } = scene!;
        await pullDirectorySpelledTwoWays();

        const offered = (await cleanPreview(bob)).map((c) => c.path);
        await cleanExecute(bob, offered);

        expect(
          exists(bob, "content/maps/forest.txt"),
          `Clean Workspace offered ${JSON.stringify(offered)} as untracked and deleted it; ` +
            `the state still records content/maps/forest.txt, so it now shows as deleted by Bob`,
        ).toBe(true);
      },
    );

    it("does not leave two spellings on the server when a case-only rename is submitted as the new file", async () => {
      // Bob renames Content/Hero.txt to Content/hero.txt in Explorer or
      // Finder. The pending list shows the old name deleted and the new name
      // untracked, and Bob submits the new file. The head now has both, which
      // is DL-08 reached by an everyday action, with no other client involved.
      const { alice, bob } = scene!;
      await put(alice, "Content/Hero.txt", "hero\n");
      await stageAndSubmit(alice, ["Content/Hero.txt"]);
      await syncLatest(bob);

      await fsp.rename(
        fileIn(bob, "Content/Hero.txt"),
        fileIn(bob, "Content/hero.txt"),
      );
      const outcome = await stageAndSubmit(bob, ["Content/hero.txt"]).then(
        () => "Bob's submit went through",
        (e: unknown) => `Bob's submit was refused (${(e as Error).message})`,
      );

      const spellings = (
        await pathsAtHead(testDb.client, scene!.repoId, "main")
      ).filter((p) => p.toLowerCase() === "content/hero.txt");
      expect(
        spellings,
        `${outcome}; on Windows and macOS these are one file`,
      ).toHaveLength(1);
    });

    it.runIf(realFilterPaths !== null)(
      "pulls a folder whose Team Sync rule was typed in another case",
      async () => {
        // On Windows and macOS "content/maps/" names the Content/Maps folder,
        // so nothing looks wrong with the rule. The daemon's own filter
        // agrees, but the native filter it hands the rule to compares bytes,
        // so the pull skips the folder, records the workspace at the head
        // anyway, and no later pull mentions those files again. Uses the real
        // native matcher (see native/include-filter.test.ts).
        const { alice, bob } = scene!;
        await put(alice, "Source/game.cpp", "int main() { return 0; }\n");
        await put(alice, "Content/Maps/arena.umap", "arena");
        await stageAndSubmit(alice, ["Source", "Content"]);
        await setTeamSync(bob, {
          customIncludeRules: ["Source/", "content/maps/"],
        });
        overrides.nativeFilter = realFilterPaths!;

        await syncLatest(bob);
        await syncLatest(bob);

        const state = await getWorkspaceState(bob.root, "sqlite");
        expect(
          exists(bob, "Content/Maps/arena.umap"),
          `the workspace is recorded at #${state.changelistNumber} (the head) ` +
            `with ${JSON.stringify(Object.keys(state.files))}, and nothing is pending`,
        ).toBe(true);
      },
    );
  });

  describe("names that are one file on macOS (Unicode normalization)", () => {
    it.runIf(normalizationInsensitive)(
      "keeps Docs/Café.txt when its decomposed spelling is deleted upstream",
      async () => {
        // The same as the case collision above, for names typed as "é" (one
        // code point, as Windows and Linux keyboards produce) and as "e" plus
        // a combining accent (as older macOS tools write). macOS stores
        // either and looks both up as the same file.
        const { alice, bob } = scene!;
        const composed = "Docs/Caf\u00e9.txt";
        const decomposed = "Docs/Cafe\u0301.txt";
        await put(alice, composed, "menu, as alice typed it\n");
        await stageAndSubmit(alice, [composed]);
        await submitDirect(alice, {
          write: { [decomposed]: "carol's notes about the menu\n" },
        });
        await syncLatest(bob);
        await submitDirect(alice, { remove: [decomposed] });

        await syncLatest(bob);

        expect(
          exists(bob, composed),
          `${composed} is still at the head, but Bob's pull deleted it. Pending: ${JSON.stringify(
            await pendingChanges(bob),
          )}`,
        ).toBe(true);
      },
    );
  });

  describe("file times", () => {
    it("still sees a same-size edit made within one timestamp tick of a pull", async () => {
      // "Unchanged" is decided by size and mtime alone while the state has no
      // hash, which is right after every pull. A filesystem stamps writes with
      // a clock that moves in ticks (2 s on FAT32 and exFAT drives shared
      // between Macs and PCs, 1 s on HFS+, a few milliseconds on NTFS and
      // ext4), so a tool that rewrites a file right after a sync (a build
      // step stamping a version, an editor resaving) can leave it with the
      // size and mtime the pull recorded.
      const { alice, bob } = scene!;
      await put(alice, "notes.txt", "status: draft\n");
      await stageAndSubmit(alice, ["notes.txt"]);
      await syncLatest(bob);
      await put(alice, "notes.txt", "status: final\n");
      await stageAndSubmit(alice, ["notes.txt"]);

      overrides.writeTime = new Date("2026-01-01T00:00:00Z");
      await syncLatest(bob);
      await put(bob, "notes.txt", "status: fixed\n"); // the same length
      delete overrides.writeTime;

      expect
        .soft(
          await pendingChanges(bob),
          "the edit has the size and mtime the pull recorded, and nothing compares content",
        )
        .toHaveProperty(["notes.txt"], stillPending);

      await put(alice, "notes.txt", "status: shipped\n");
      await stageAndSubmit(alice, ["notes.txt"]);
      await syncLatest(bob);

      expect(
        await survives(bob, "notes.txt", "status: fixed"),
        `${await describeFile(bob, "notes.txt")}, and no backup holds Bob's edit`,
      ).toBe(true);
    });
  });

  describe("text encodings and line endings", () => {
    it("control: merges a CRLF working copy with an LF upstream change, keeping CRLF", async () => {
      // What does hold up: Bob's Windows editor saved the file with CRLF
      // line endings. The merge compares lines without their endings and
      // writes the working copy's.
      const { alice, bob } = scene!;
      await put(alice, "notes.txt", "one\ntwo\nthree\nfour\nfive\n");
      await stageAndSubmit(alice, ["notes.txt"]);
      await syncLatest(bob);

      await put(
        bob,
        "notes.txt",
        "one (bob)\r\ntwo\r\nthree\r\nfour\r\nfive\r\n",
      );
      await put(alice, "notes.txt", "one\ntwo\nthree\nfour\nfive (alice)\n");
      await stageAndSubmit(alice, ["notes.txt"]);

      await syncLatest(bob);

      expect(await read(bob, "notes.txt")).toBe(
        "one (bob)\r\ntwo\r\nthree\r\nfour\r\nfive (alice)\r\n",
      );
    });

    it("control: sets a UTF-16 file changed on both sides aside whole, instead of merging it as UTF-8", async () => {
      // What does hold up: Windows tools write UTF-16 (Unreal's localization
      // files, PowerShell, resource scripts). Merging it as UTF-8 would
      // corrupt it, so the pull keeps the server's version in place and
      // Bob's in a backup, and says so.
      const { alice, bob } = scene!;
      const utf16 = (text: string) =>
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(text, "utf16le"),
        ]);
      const strings = "Localization/Game.txt";
      await put(alice, strings, utf16("Hello=Hello\nBye=Bye\n"));
      await stageAndSubmit(alice, [strings]);
      await syncLatest(bob);

      await put(bob, strings, utf16("Hello=Bonjour\nBye=Bye\n"));
      await put(alice, strings, utf16("Hello=Hello\nBye=Au revoir\n"));
      await stageAndSubmit(alice, [strings]);

      const result = (await syncLatest(bob)) as PullMergeResult;

      expect(await fsp.readFile(fileIn(bob, strings))).toEqual(
        utf16("Hello=Hello\nBye=Au revoir\n"),
      );
      expect(
        await backupsContaining(
          bob,
          Buffer.from("Bonjour", "utf16le").toString("utf8"),
        ),
      ).toHaveLength(1);
      expect(result.localChangesSetAside).toEqual([
        expect.objectContaining({ relativePath: strings, reason: "not-text" }),
      ]);
    });
  });

  describe("names only Linux and macOS allow", () => {
    it.skipIf(windows)(
      "still submits other changes when a stray file's name contains a backslash",
      async () => {
        // A script written for Windows, run on Linux or macOS, creates
        // "C:\Users\bob\build.log" as one file in the workspace root;
        // backslash is an ordinary character there. The scan rebuilds each
        // file's path with backslashes turned into slashes, stats a path that
        // does not exist, and the whole refresh fails, so nothing can be
        // submitted until the file is found and removed.
        const { alice, bob } = scene!;
        await put(alice, "notes.txt", "v1\n");
        await stageAndSubmit(alice, ["notes.txt"]);
        await syncLatest(bob);

        await put(bob, "C:\\Users\\bob\\build.log", "log\n");
        await put(bob, "notes.txt", "v2 from bob\n");
        await stageAndSubmit(bob, ["notes.txt"]);

        expect(
          await contentAtHead(
            testDb.client,
            scene!.repoId,
            "main",
            "notes.txt",
          ),
        ).toBe("v2 from bob\n");
      },
    );
  });
});
