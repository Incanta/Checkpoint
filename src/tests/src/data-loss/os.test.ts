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

vi.mock(
  "@checkpointvcs/longtail-addon",
  async () => (await import("./stack")).fakeAddon,
);
vi.mock("@checkpointvcs/common", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stack = await import("./stack");
  return {
    ...actual,
    CreateApiClientAuth: stack.createApiClientAuth,
    GetAuthConfigUser: stack.getAuthConfigUser,
  };
});
vi.mock(
  "../../../core/daemon/src/daemon-config.js",
  async () => (await import("./stack")).fakeDaemonConfigModule,
);
vi.mock(
  "../../../core/daemon/src/logging.js",
  async () => (await import("./stack")).fakeLoggingModule,
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
} from "./stack";

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

  describe("files open in another program (Windows)", () => {
    it.runIf(windows)(
      "puts local edits back when a file the pull deletes is open in the Unreal Editor",
      async () => {
        // DL-05 with a real lock instead of a simulated one. The editor holds
        // packages it has loaded open for reading and denies deletes, so the
        // delete pass fails with EPERM after the native pass has already
        // written Alice's a.txt over Bob's edit.
        const { alice, bob } = scene!;
        await put(alice, "a.txt", "a: line one\n");
        await put(alice, "b.txt", "b: will be deleted upstream\n");
        await stageAndSubmit(alice, ["a.txt", "b.txt"]);
        await syncLatest(bob);

        await put(bob, "a.txt", "a: line one\nbob's local line\n");
        await put(alice, "a.txt", "a: alice rewrote this line\n");
        await fsp.rm(fileIn(alice, "b.txt"));
        await stageAndSubmit(alice, ["a.txt", "b.txt"]);

        const release = await holdOpen(fileIn(bob, "b.txt"), "read");
        try {
          await expect(syncLatest(bob)).rejects.toThrow(/EPERM|EBUSY/);
        } finally {
          await release();
        }

        const backups = await backupsContaining(bob, "bob's local line");
        expect(
          await read(bob, "a.txt"),
          `Bob's edit is only in ${backups.length ? backups.join(", ") : "no backup at all"}`,
        ).toBe("a: line one\nbob's local line\n");
      },
    );

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
      "does not leave the files a sync filter change removed looking deleted when it cannot remove one",
      async () => {
        // Bob narrows his sync to code. The filter deletes the excluded files
        // one by one and only then drops them from the workspace state; the
        // last of them is open in the editor, so the delete throws and the
        // state keeps every one of them.
        const { alice, bob } = scene!;
        await put(alice, "Source/game.cpp", "int main() { return 0; }\n");
        await put(alice, "Content/level1.txt", "level 1\n");
        await put(alice, "Content/level2.txt", "level 2\n");
        await put(alice, "Content/level3.txt", "level 3\n");
        await stageAndSubmit(alice, ["Source", "Content"]);
        await syncLatest(bob);

        const order = Object.keys(
          (await getWorkspaceState(bob.root, "sqlite")).files,
        ).filter((p) => p.startsWith("Content/"));
        await setTeamSync(bob, { customIncludeRules: ["Source/"] });

        const release = await holdOpen(fileIn(bob, order.at(-1)!), "read");
        try {
          await expect(syncLatest(bob)).rejects.toThrow(/EPERM|EBUSY/);
        } finally {
          await release();
        }

        const pending = await pendingChanges(bob);
        expect(
          Object.keys(pending).filter((p) => pending[p] === "Deleted"),
          `the filter removed these from disk but not from the state, so "submit everything" deletes them for everyone`,
        ).toEqual([]);
      },
    );
  });

  describe("names Windows cannot store", () => {
    it.runIf(windows)(
      "leaves nothing pending after pulling a file a Mac or Linux user named with a colon",
      async () => {
        // "standup 10:15.txt" is an ordinary name on Linux, and a Mac user
        // who types "standup 10/15" in Finder gets that name underneath. NTFS
        // reads it as the stream "15.txt" of a file named "standup 10": the
        // pull creates an empty "standup 10" and hides the text in a stream.
        // The scan finds the empty file as new and the real path as deleted,
        // so "submit everything" deletes the file for everyone.
        const { alice, bob } = scene!;
        await submitDirect(alice, {
          write: { "Notes/standup 10:15.txt": "who is doing what\n" },
        });

        await syncLatest(bob);

        expect(await pendingChanges(bob)).toEqual({});
      },
    );
  });

  describe("the workspace's own .checkpoint directory", () => {
    /**
     * Bob has synced and has an unsubmitted edit. Another client records a
     * changelist that adds a workspace.json under `spelling` (anything with
     * a write token can; the daemon itself never stages .checkpoint). It
     * narrows the sync filter to nothing, and Bob syncs.
     */
    async function plantWorkspaceConfig(spelling: string) {
      const { alice, bob } = scene!;
      await put(alice, "Source/game.cpp", "int main() { return 0; }\n");
      await put(alice, "Content/level.txt", "level\n");
      await stageAndSubmit(alice, ["Source", "Content"]);
      await syncLatest(bob);
      await setTeamSync(bob, {});
      await put(
        bob,
        "Content/level.txt",
        "level, plus bob's unsubmitted edits\n",
      );

      await submitDirect(alice, {
        write: {
          [`${spelling}/workspace.json`]: JSON.stringify({
            teamSync: { customIncludeRules: ["Nothing/"] },
          }),
        },
      });
      await syncLatest(bob);
    }

    for (const [spelling, applies, where] of [
      [".checkpoint", true, "everywhere"],
      [".CHECKPOINT", caseInsensitive, "Windows and macOS"],
      ["CHECKP~1", keepsShortNames, "Windows volumes with 8.3 short names"],
    ] as const) {
      it.runIf(applies)(
        `does not let a pull replace the workspace's config through ${spelling}/workspace.json (${where})`,
        async () => {
          // The pull writes the file into Bob's .checkpoint directory. The
          // sync pipeline then reads its filter from that file and deletes
          // every tracked file outside it, the edited one included, with no
          // backup (DL-04); the config itself is tracked now, so it goes too.
          const { bob } = scene!;
          await plantWorkspaceConfig(spelling);

          expect(
            exists(bob, "Source/game.cpp") &&
              (await survives(
                bob,
                "Content/level.txt",
                "bob's unsubmitted edits",
              )),
            `${await describeFile(bob, ".checkpoint/workspace.json")}; ` +
              `${await describeFile(bob, "Source/game.cpp")}; ` +
              `${await describeFile(bob, "Content/level.txt")}`,
          ).toBe(true);
        },
      );
    }
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
