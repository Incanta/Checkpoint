/**
 * Red team: what the app accepts on push, and what merging and deleting
 * branches do with work, checked at the API (in-process routers over the
 * SQLite test database, as in src/api). See ./README.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../harness/db";
import {
  makeOrg,
  makeRepo,
  makeUser,
  makeWorkspace,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { getStateTreePaths } from "~/server/state-tree";
import { resolveFileSource } from "~/server/read-file-at-changelist";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

interface Mod {
  path: string;
  delete?: boolean;
  baseChangelist?: number | null;
}

describe("data loss: server", () => {
  let testDb: TestDb;
  let caller: Caller;
  let repoId: string;
  let workspaceId: string;

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
    const owner = await makeUser(testDb.client);
    const org = await makeOrg(testDb.client, {
      ownerId: owner.id,
      ownerRole: "ADMIN",
    });
    const repo = await makeRepo(testDb.client, org.id, owner.id);
    const workspace = await makeWorkspace(
      testDb.client,
      repo.id,
      org.id,
      owner.id,
    );
    caller = await makeAppCaller({ asUser: owner });
    repoId = repo.id;
    workspaceId = workspace.id;
  });

  function submit(branchName: string, mods: Mod[], versionIndex = "fake.lvi") {
    return caller.changelist.createChangelist({
      message: `${branchName}: ${mods.map((m) => m.path).join(", ")}`,
      repoId,
      versionIndex,
      branchName,
      modifications: mods.map((m) => ({
        path: m.path,
        delete: m.delete ?? false,
        ...(m.baseChangelist !== undefined && {
          baseChangelist: m.baseChangelist,
        }),
      })),
      keepCheckedOut: false,
      workspaceId,
    });
  }

  /** The changelist number of a submit of whole files to a branch. */
  async function write(
    branchName: string,
    ...paths: string[]
  ): Promise<number> {
    return (
      await submit(
        branchName,
        paths.map((path) => ({ path })),
      )
    ).number;
  }

  async function branchFrom(parent: string, name: string) {
    await caller.branch.createBranch({
      repoId,
      name,
      type: "FEATURE",
      parentBranchName: parent,
    });
  }

  async function head(branchName: string): Promise<number> {
    return (
      await testDb.client.branch.findFirstOrThrow({
        where: { repoId, name: branchName },
      })
    ).headNumber;
  }

  async function treeOf(branchName: string): Promise<Record<string, number>> {
    return Object.fromEntries(
      await getStateTreePaths(testDb.client, repoId, await head(branchName)),
    );
  }

  const merge = (incoming: string, target = "main") =>
    caller.branch.mergeBranch({
      repoId,
      incomingBranchName: incoming,
      targetBranchName: target,
    });

  describe("push", () => {
    it.each([
      ["the file name", "Content/Hero.txt", "Content/hero.txt"],
      ["a directory name", "Docs/Guide/intro.txt", "docs/guide/intro.txt"],
      // NTFS and APFS fold more than ASCII. A fix that folds with SQL
      // (SQLite's LOWER and NOCASE are ASCII-only) would miss this one.
      ["a non-ASCII letter", "Content/Ärger.txt", "Content/ärger.txt"],
      // A file and a directory cannot share a name; on Windows and macOS
      // the pull cannot create the directory at all.
      ["a file and a directory", "Content/Level", "Content/level/arena.umap"],
    ])(
      "refuses a new path that differs from an existing one only in the case of %s",
      async (_what, existing, colliding) => {
        // Both are one file on Windows and macOS. Once the tree holds both,
        // every pull there writes two versions into one file, and removing
        // either spelling later deletes the file the other still names.
        await write("main", existing);

        await expect(
          submit("main", [{ path: colliding, baseChangelist: null }]),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/BAD_REQUEST|CONFLICT/),
        });
      },
    );

    it("control: accepts a case-only rename made in one changelist", async () => {
      // What a fix must keep working: the old spelling goes out in the same
      // changelist that brings the new one in.
      const added = await write("main", "Content/hero.txt");
      await submit("main", [
        { path: "Content/hero.txt", delete: true, baseChangelist: added },
        { path: "Content/Hero.txt", baseChangelist: null },
      ]);
      expect(Object.keys(await treeOf("main"))).toEqual(["Content/Hero.txt"]);
    });

    it.each([
      "../escape.txt",
      "Content/../../escape.txt",
      "Content\\..\\..\\escape.txt",
      "./a.txt",
      "Content/./a.txt",
      "Content//a.txt",
      "/rooted.txt",
      "Content/a.txt/",
      "C:/Windows/System32/drivers/etc/hosts",
    ])(
      "refuses a path that is not a canonical repo-relative path: %s",
      async (path) => {
        // Paths are stored as the client sent them and handed back to every
        // daemon that pulls. A daemon joins them to its workspace root and
        // writes or deletes there (see pull.test.ts), so "../" reaches outside
        // the workspace, and spellings the tree folds together ("a//b", "a/./b")
        // name a second File row for the same tree entry.
        await expect(
          submit("main", [{ path, baseChangelist: null }]),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
        });
      },
    );

    /**
     * Alice holds an exclusive claim on Content/hero.uasset; Bob submits his
     * own version of it under `spelling`, as an edit of the claimed file
     * ("edit") or as a new file ("new", what a Linux client sends for a name
     * that is a different file there). The submit must be refused, and the
     * claimed file must still come from Alice's changelist.
     */
    async function bobSubmitsPastAlicesClaim(
      spelling: string,
      as: "edit" | "new",
    ) {
      const added = await write("main", "Content/hero.uasset");
      await caller.file.checkout({
        repoId,
        workspaceId,
        filePath: "Content/hero.uasset",
      });

      const bob = await makeUser(testDb.client, { name: "bob" });
      const repo = await testDb.client.repo.findUniqueOrThrow({
        where: { id: repoId },
      });
      await testDb.client.orgUser.create({
        data: { orgId: repo.orgId, userId: bob.id, role: "ADMIN" },
      });
      const bobsWorkspace = await makeWorkspace(
        testDb.client,
        repoId,
        repo.orgId,
        bob.id,
      );
      const asBob = await makeAppCaller({ asUser: bob });

      await expect(
        asBob.changelist.createChangelist({
          message: "bob's hero",
          repoId,
          versionIndex: "bob.lvi",
          branchName: "main",
          modifications: [
            {
              path: spelling,
              delete: false,
              baseChangelist: as === "edit" ? added : null,
            },
          ],
          keepCheckedOut: false,
          workspaceId: bobsWorkspace.id,
        }),
      ).rejects.toMatchObject({
        // A new file that collides with an existing name may fairly be
        // refused as a conflict; an edit must be refused for the claim.
        code: expect.stringMatching(
          as === "edit"
            ? /FORBIDDEN|BAD_REQUEST/
            : /FORBIDDEN|BAD_REQUEST|CONFLICT/,
        ),
      });
      expect((await treeOf("main"))["Content/hero.uasset"]).toBe(added);
    }

    it.each([
      "Content//hero.uasset",
      "/Content/hero.uasset",
      "Content/hero.uasset/",
    ])(
      "does not let %s past someone else's exclusive claim on Content/hero.uasset",
      async (spelling) => {
        // The claim check looks up File rows by the path exactly as spelled;
        // the tree drops empty segments, so it folds these spellings onto the
        // claimed file. A submit that spells the path this way skips the lock
        // and replaces the binary its holder is in the middle of editing,
        // which cannot be merged. ("Content/./hero.uasset" is not folded: the
        // tree keeps "." as a directory, a collision of its own, above.)
        await bobSubmitsPastAlicesClaim(spelling, "edit");
      },
    );

    it.each([
      // Windows and macOS: another case.
      "content/HERO.uasset",
      // Windows: the file's main data stream, by name (NTFS resolves it even
      // through the \\?\ paths Node and the addon use).
      "Content/hero.uasset::$DATA",
      // Windows volumes that keep 8.3 short names: hero.uasset's short name.
      "Content/HERO~1.UAS",
    ])(
      "does not let %s, the same file on Windows, past someone else's exclusive claim on Content/hero.uasset",
      async (spelling) => {
        // The tree keeps these as separate paths, so the server sees a new
        // file and checks no claim. Every Windows pull, Alice's included,
        // then writes Bob's version into the file she holds.
        await bobSubmitsPastAlicesClaim(spelling, "new");
      },
    );

    /** The paths, of those given, that the server accepted as new files. */
    async function accepted(paths: string[]): Promise<string[]> {
      const out: string[] = [];
      for (const candidate of paths) {
        const ok = await submit("main", [
          { path: candidate, baseChangelist: null },
        ]).then(
          () => true,
          () => false,
        );
        if (ok) out.push(candidate);
      }
      return out;
    }

    it("refuses names Windows reserves for devices", async () => {
      // Ordinary names on Linux and macOS ("aux.h" turns up in C codebases).
      // On Windows the pull still creates them, through \\?\ paths, but
      // Explorer cannot delete them and most programs cannot open them.
      expect(
        await accepted([
          "CON",
          "Source/aux.h",
          "Content/Con.uasset",
          "Content/NUL/level.umap",
          "Logs/COM1.log",
          "Logs/lpt9",
          "Logs/COM\u00b9.txt",
          "Logs/CONIN$",
        ]),
      ).toEqual([]);
    });

    it("refuses names that end in a dot or a space", async () => {
      // Windows strips a trailing dot or space from any name a program asks
      // for, so a program asking for "level." opens "level" (another file, or
      // nothing) and cannot open or delete the file the pull wrote.
      expect(
        await accepted([
          "Content/level.",
          "Content/level ",
          "Content/Maps./arena.umap",
          "Content/Maps /arena.umap",
        ]),
      ).toEqual([]);
    });

    it("refuses characters Windows does not allow in names", async () => {
      // ":" is the worst of them: NTFS reads "standup 10:15.txt" as the
      // stream "15.txt" of a file "standup 10", so the content vanishes
      // into a hidden stream on every Windows pull (see os.test.ts).
      expect(
        await accepted([
          "Notes/standup 10:15.txt",
          "Docs/what?.txt",
          "Docs/a*b.txt",
          "Docs/a|b.txt",
          'Docs/"quoted".txt',
          "Docs/<draft>.txt",
          "Docs/tab\there.txt",
          "Docs/line\nbreak.txt",
        ]),
      ).toEqual([]);
    });

    it("refuses a name longer than Linux filesystems allow", async () => {
      // 100 CJK characters: 100 UTF-16 units, which Windows allows, but 300
      // bytes of UTF-8, over the 255-byte name limit of ext4, XFS, and
      // Btrfs. Every pull on a Linux machine (a build agent) fails on it.
      expect(await accepted([`Docs/${"文".repeat(100)}.txt`])).toEqual([]);
    });

    it.each([
      ["the file name", "Docs/Caf\u00e9.txt", "Docs/Cafe\u0301.txt"],
      [
        "a directory name",
        "R\u00e9sum\u00e9s/alice.txt",
        "Re\u0301sume\u0301s/bob.txt",
      ],
    ])(
      "refuses a new path that differs from an existing one only in the Unicode normalization of %s",
      async (_what, existing, colliding) => {
        // "é" as one code point (what Windows and Linux keyboards produce)
        // and as "e" plus a combining accent (what older macOS tools write)
        // are different bytes and one file on macOS, with the same results
        // as the case collisions above (see os.test.ts).
        await write("main", existing);

        await expect(
          submit("main", [{ path: colliding, baseChangelist: null }]),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/BAD_REQUEST|CONFLICT/),
        });
      },
    );

    it("refuses paths in a workspace's .checkpoint directory, in every spelling a filesystem folds onto it", async () => {
      // Every pull would write the daemon's own files: workspace.json, which
      // holds the sync filter and custom build steps, and the state database
      // (see os.test.ts). Blocking the literal name is not enough on Windows
      // and macOS.
      expect(
        await accepted([
          ".checkpoint/workspace.json",
          ".CHECKPOINT/workspace.json",
          ".Checkpoint/state.db",
          "CHECKP~1/workspace.json",
        ]),
      ).toEqual([]);
    });

    it("refuses a changelist that names no version index for the files it writes", async () => {
      // The storage server checks that a submit's version index is really in
      // storage before it asks the app to record the changelist. The app's
      // own endpoint, which any token with write access can call, checks
      // nothing: a changelist can point a file at content that does not
      // exist, and nobody can sync it from then on.
      const added = await write("main", "Content/level.txt");

      const recorded = await submit(
        "main",
        [{ path: "Content/level.txt", baseChangelist: added }],
        "",
      ).then(
        (cl) => cl.number,
        () => null,
      );

      if (recorded !== null) {
        const source = await resolveFileSource(
          testDb.client,
          repoId,
          "Content/level.txt",
          recorded,
        );
        expect(source, "the file is unreadable at the new head").not.toBeNull();
      }
      expect(recorded).toBeNull();
    });
  });

  describe("merge", () => {
    it("merges a stacked branch after its parent merged, when both changed the same file in turn", async () => {
      // upper's x.txt is built on lower's. After lower lands, main holds
      // lower's x.txt, but the squash merge records no link from main to
      // lower's changelists, so the merge base for upper is still the fork
      // from main, and x.txt looks changed differently on both sides.
      await write("main", "x.txt");
      await branchFrom("main", "lower");
      await write("lower", "x.txt");
      await branchFrom("lower", "upper");
      const u = await write("upper", "x.txt");
      await merge("lower");

      await merge("upper");

      expect((await treeOf("main"))["x.txt"]).toBe(u);
    });

    it("merges once a conflict is resolved on the branch, as the refusal says to", async () => {
      // The refusal says: bring main into the branch, resolve there, merge
      // again. The only way to put a resolved file on the branch is to submit
      // it there, and that never moves the merge base, so the same path
      // conflicts again forever. The existing suite's "resolved" case deletes
      // and recreates the branch, which throws away everything else on it.
      await write("main", "both.txt", "other.txt");
      await branchFrom("main", "feature");
      const f1 = await write("feature", "both.txt");
      await write("feature", "feature-only.txt");
      await write("main", "both.txt");
      await expect(merge("feature")).rejects.toMatchObject({
        code: "CONFLICT",
      });

      const resolved = (
        await submit("feature", [{ path: "both.txt", baseChangelist: f1 }])
      ).number;

      await merge("feature");

      const main = await treeOf("main");
      expect(main["both.txt"]).toBe(resolved);
      expect(main["feature-only.txt"]).toBeDefined();
    });
  });

  describe("branches", () => {
    it("refuses to delete a branch whose changelists were never merged, unless told to discard them", async () => {
      // Archiving with claims outstanding needs an explicit flag
      // (releaseOutstandingClaims); deleting a branch full of unmerged work
      // needs nothing. Its changelists stay in the database, but no branch
      // reaches them any more, so history, pulls, and merge requests cannot.
      await write("main", "a.txt");
      await branchFrom("main", "feature");
      await write("feature", "a week of work.txt");

      await expect(
        caller.branch.deleteBranch({ repoId, branchName: "feature" }),
      ).rejects.toThrow();

      expect(await head("feature")).toBeGreaterThan(1);
    });
  });
});
