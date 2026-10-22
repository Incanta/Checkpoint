/**
 * Volumes that take two spellings for one file: NTFS and APFS ignore case,
 * and APFS and HFS+ ignore Unicode normalization. Repositories can hold two
 * spellings of one name (from before the server refused new ones, or made on
 * Linux), and the daemon must treat them as the one file they are there
 * (src/core/daemon/src/util/volume.ts). Moved here from the data-loss red
 * team (DL-07, DL-19, and the daemon sides of DL-08 and DL-18).
 *
 * Each test runs where its behavior exists, by probing the filesystem the
 * workspaces live on. Driven through the daemon's own endpoints against the
 * real app routers, with only the native addon faked (src/harness/stack.ts).
 * Changelists recorded with submitDirect bypass the server's path rules, as an
 * older server stored them.
 */
import { promises as fsp } from "node:fs";
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
import { getWorkspaceState } from "../../../core/daemon/src/util/util.js";
import {
  clearVolumeProbes,
  volumeFolds,
} from "../../../core/daemon/src/util/volume.js";
import {
  apiAs,
  storeVersion,
  cleanExecute,
  cleanPreview,
  contentAtHead,
  exists,
  fileIn,
  filesystemIsCaseInsensitive,
  filesystemIsNormalizationInsensitive,
  makeScene,
  pathsAtHead,
  pendingChanges,
  put,
  read,
  resetStack,
  stageAndSubmit,
  submitDirect,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

const caseInsensitive = await filesystemIsCaseInsensitive();
const normalizationInsensitive = await filesystemIsNormalizationInsensitive();

describe("the volume probe", () => {
  it("answers as the filesystem behaves", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-volume-"));
    try {
      clearVolumeProbes();
      expect(await volumeFolds(dir)).toEqual({
        case: caseInsensitive,
        normalization: normalizationInsensitive,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Each test runs two daemons' worth of submits and pulls (and the Windows
// lock tests start a PowerShell), which hosted runners can take well past the
// suite's default timeout on.
describe(
  "volumes that take two spellings for one file",
  { timeout: 120_000 },
  () => {
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

    describe("case", () => {
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

      it.runIf(caseInsensitive)(
        "submits a rename made by case in Explorer or Finder as a rename",
        async () => {
          const { alice, bob } = scene!;
          await put(alice, "Content/Hero.txt", "hero\n");
          await stageAndSubmit(alice, ["Content/Hero.txt"]);
          await syncLatest(bob);

          await fsp.rename(
            fileIn(bob, "Content/Hero.txt"),
            fileIn(bob, "Content/hero.txt"),
          );
          expect(await pendingChanges(bob)).toEqual({
            "Content/Hero.txt": "Deleted",
            "Content/hero.txt": "Local",
          });
          await stageAndSubmit(bob, ["Content/hero.txt"]);

          expect(
            await pathsAtHead(testDb.client, scene!.repoId, "main"),
          ).toEqual(["Content/hero.txt"]);
          expect(await pendingChanges(bob)).toEqual({});
        },
      );

      it.runIf(caseInsensitive)(
        "brings a directory renamed by case upstream, with nothing pending",
        async () => {
          const { alice, bob } = scene!;
          await put(alice, "docs/a.txt", "a\n");
          await put(alice, "docs/b.txt", "b\n");
          await stageAndSubmit(alice, ["docs/a.txt", "docs/b.txt"]);
          await syncLatest(bob);

          await submitDirect(alice, {
            write: { "Docs/a.txt": "a\n", "Docs/b.txt": "b, edited\n" },
            remove: ["docs/a.txt", "docs/b.txt"],
          });
          await syncLatest(bob);

          expect(await read(bob, "Docs/a.txt")).toBe("a\n");
          expect(await read(bob, "Docs/b.txt")).toBe("b, edited\n");
          expect(await pendingChanges(bob)).toEqual({});
          expect(
            Object.keys(
              (await getWorkspaceState(bob.root, "sqlite")).files,
            ).sort(),
          ).toEqual(["Docs/a.txt", "Docs/b.txt"]);
          // The directory itself takes the new spelling, so the scan has no
          // difference to take for a rename Bob made.
          expect(await fsp.readdir(bob.root)).toContain("Docs");
          expect(await fsp.readdir(bob.root)).not.toContain("docs");
        },
      );

      it.runIf(caseInsensitive)(
        "submits a directory renamed by case in Explorer or Finder as a rename",
        async () => {
          const { alice, bob } = scene!;
          await put(alice, "content/maps/a.txt", "a\n");
          await put(alice, "content/maps/b.txt", "b\n");
          await put(alice, "content/top.txt", "top\n");
          await stageAndSubmit(alice, [
            "content/maps/a.txt",
            "content/maps/b.txt",
            "content/top.txt",
          ]);
          await syncLatest(bob);

          await fsp.rename(fileIn(bob, "content"), fileIn(bob, "Content"));
          expect(await pendingChanges(bob)).toEqual({
            "content/maps/a.txt": "Deleted",
            "content/maps/b.txt": "Deleted",
            "content/top.txt": "Deleted",
            "Content/maps/a.txt": "Local",
            "Content/maps/b.txt": "Local",
            "Content/top.txt": "Local",
          });

          // Staging one file stages everything the rename moved: the server
          // refuses a tree with both spellings of the directory.
          await stageAndSubmit(bob, ["Content/top.txt"]);
          expect(
            await pathsAtHead(testDb.client, scene!.repoId, "main"),
          ).toEqual([
            "Content/maps/a.txt",
            "Content/maps/b.txt",
            "Content/top.txt",
          ]);
          expect(await pendingChanges(bob)).toEqual({});

          // Alice's copy follows, directory and all, with nothing pending.
          await syncLatest(alice);
          expect(await fsp.readdir(alice.root)).toContain("Content");
          expect(await read(alice, "Content/maps/b.txt")).toBe("b\n");
          expect(await pendingChanges(alice)).toEqual({});
        },
      );

      it.runIf(caseInsensitive)(
        "leaves a new file in a directory renamed by case untracked",
        async () => {
          const { alice, bob } = scene!;
          await put(alice, "docs/a.txt", "a\n");
          await stageAndSubmit(alice, ["docs/a.txt"]);
          await syncLatest(bob);

          await fsp.rename(fileIn(bob, "docs"), fileIn(bob, "Docs"));
          await put(bob, "Docs/notes.txt", "mine\n");
          await stageAndSubmit(bob, ["Docs/a.txt"]);

          expect(
            await pathsAtHead(testDb.client, scene!.repoId, "main"),
          ).toEqual(["Docs/a.txt"]);
          expect(await pendingChanges(bob)).toEqual({
            "Docs/notes.txt": "Local",
          });
        },
      );

      it.runIf(caseInsensitive)(
        "does not take a directory a pull could not rename for one Bob renamed",
        async () => {
          const { alice, bob } = scene!;
          await put(alice, "docs/a.txt", "a\n");
          await stageAndSubmit(alice, ["docs/a.txt"]);
          await syncLatest(bob);

          // Something holds the directory (a program with a file inside it
          // open, say), so the pull cannot rename it this time.
          const rename = fsp.rename.bind(fsp);
          const spy = vi
            .spyOn(fsp, "rename")
            .mockImplementation(async (from, to) => {
              if (path.basename(String(from)) === "docs") {
                throw Object.assign(new Error("EBUSY: resource busy"), {
                  code: "EBUSY",
                });
              }
              return rename(from, to);
            });
          try {
            await submitDirect(alice, {
              write: { "Docs/a.txt": "a\n" },
              remove: ["docs/a.txt"],
            });
            await syncLatest(bob);
          } finally {
            spy.mockRestore();
          }
          expect(await fsp.readdir(bob.root)).toContain("docs");
          expect(await pendingChanges(bob)).toEqual({});
          expect(
            (await getWorkspaceState(bob.root, "sqlite")).pendingDirRenames,
          ).toEqual(["Docs"]);

          // The next pull finishes it.
          await submitDirect(alice, { write: { "other.txt": "o\n" } });
          await syncLatest(bob);
          expect(await fsp.readdir(bob.root)).toContain("Docs");
          expect(await pendingChanges(bob)).toEqual({});
          expect(
            (await getWorkspaceState(bob.root, "sqlite")).pendingDirRenames,
          ).toBeUndefined();
        },
      );

      it.runIf(!caseInsensitive)(
        "keeps two spellings as two files where the filesystem tells them apart",
        async () => {
          const { alice, bob } = scene!;
          await put(alice, "Content/Hero.txt", "hero\n");
          await stageAndSubmit(alice, ["Content/Hero.txt"]);
          await submitDirect(alice, {
            write: { "Content/hero.txt": "carol's notes\n" },
          });
          await syncLatest(bob);
          await submitDirect(alice, { remove: ["Content/hero.txt"] });

          await syncLatest(bob);

          expect(exists(bob, "Content/Hero.txt")).toBe(true);
          expect(exists(bob, "Content/hero.txt")).toBe(false);
          expect(await pendingChanges(bob)).toEqual({});
        },
      );

      it.skipIf(!caseInsensitive)(
        "brings the new content of a file renamed by case only (case-insensitive filesystems)",
        async () => {
          // Alice (on Linux, or any client) renames Textures/hero.txt to
          // Textures/Hero.txt and updates it in one changelist. On Bob's Windows
          // machine the pull writes "Hero.txt" onto the existing hero.txt, then
          // its delete pass removes "hero.txt", which is the same file. The guard
          // had copied the old file aside as an "untracked" Hero.txt, so it puts
          // the OLD content back, and the state records it as the new version.
          const { alice, bob } = scene!;
          await put(alice, "Textures/hero.txt", "hero, original\n");
          await stageAndSubmit(alice, ["Textures/hero.txt"]);
          await syncLatest(bob);

          const head = (
            await testDb.client.branch.findFirstOrThrow({
              where: { repoId: scene!.repoId, name: "main" },
            })
          ).headNumber;
          await apiAs(alice).changelist.createChangelist({
            message: "rename hero.txt to Hero.txt and update it",
            repoId: scene!.repoId,
            versionIndex: storeVersion({
              "Textures/Hero.txt": "hero, updated by alice\n",
            }),
            branchName: "main",
            modifications: [
              { path: "Textures/hero.txt", delete: true, baseChangelist: head },
              {
                path: "Textures/Hero.txt",
                delete: false,
                baseChangelist: null,
              },
            ],
            keepCheckedOut: false,
            workspaceId: alice.workspace.id,
          });

          await syncLatest(bob);

          const recorded = (await getWorkspaceState(bob.root, "sqlite")).files[
            "Textures/Hero.txt"
          ];
          expect(
            await read(bob, "Textures/Hero.txt"),
            `the workspace state records Textures/Hero.txt at #${recorded?.changelist}, ` +
              `and nothing shows it as changed: ${JSON.stringify(await pendingChanges(bob))}`,
          ).toBe("hero, updated by alice\n");
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
  },
);

void contentAtHead;
