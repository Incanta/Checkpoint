/**
 * A pull must never destroy local work.
 *
 * These tests drive the guard that protects it (LocalChangeGuard) with a real
 * directory standing in for a workspace: files are given local changes, the
 * guard is asked to protect them, the "pull" is simulated by writing or
 * deleting files the way the native pull would, and then the guard settles
 * each one. The end-to-end version, with the real addon and a server, is
 * src/integration/daemon-pull.test.ts.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceStateFile } from "@checkpointvcs/common";

import {
  LocalChangeGuard,
  describeFailedPull,
  hasLocalChanges,
  isMergeableText,
} from "../../../core/daemon/src/util/pull-local-changes.js";
import { autoMergeText } from "../../../core/daemon/src/util/auto-merge.js";

const md5 = (bytes: Buffer | string) =>
  createHash("md5").update(bytes).digest("hex");

describe("pull: local changes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chk-pull-guard-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const full = (relativePath: string) => path.join(root, relativePath);

  async function put(relativePath: string, content: string | Buffer) {
    await mkdir(path.dirname(full(relativePath)), { recursive: true });
    await writeFile(full(relativePath), content);
  }

  /** The state entry a pull would have recorded for the file as it is now. */
  async function baseline(
    relativePath: string,
    changelist = 1,
    withHash = false,
  ): Promise<WorkspaceStateFile> {
    const s = await stat(full(relativePath));
    return {
      fileId: `id-${relativePath}`,
      changelist,
      md5: withHash ? md5(await readFile(full(relativePath))) : "",
      size: s.size,
      mtime: s.mtimeMs,
    };
  }

  /** Rewrites a file and makes sure its mtime differs from before. */
  async function edit(relativePath: string, content: string | Buffer) {
    const before = (await stat(full(relativePath))).mtimeMs;
    await writeFile(full(relativePath), content);
    const later = new Date(before + 5000);
    await utimes(full(relativePath), later, later);
  }

  const noBinary = () => false;
  const allBinary = () => true;
  const baseOf = (content: string | Buffer) => async (): Promise<Buffer> =>
    Buffer.from(content);
  const noBase = async (): Promise<Buffer> => {
    throw new Error("the base should not have been read");
  };

  async function backupCount(): Promise<number> {
    const dir = path.join(root, ".checkpoint", "pull-backups");
    if (!existsSync(dir)) return 0;
    let count = 0;
    const walk = async (d: string) => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(d, entry.name));
        else count++;
      }
    };
    await walk(dir);
    return count;
  }

  describe("hasLocalChanges", () => {
    it("is false for a file exactly as the pull left it", async () => {
      await put("a.txt", "hello");
      expect(
        await hasLocalChanges(full("a.txt"), await baseline("a.txt")),
      ).toBe(false);
      expect(
        await hasLocalChanges(full("a.txt"), await baseline("a.txt", 1, true)),
      ).toBe(false);
    });

    it("is true when the size changed", async () => {
      await put("a.txt", "hello");
      const entry = await baseline("a.txt");
      await edit("a.txt", "hello world");
      expect(await hasLocalChanges(full("a.txt"), entry)).toBe(true);
    });

    it("is true for a same-size edit, with or without a recorded hash", async () => {
      // The edit the old change detection hid: same length, different bytes.
      await put("a.bin", "AAAA");
      const plain = await baseline("a.bin");
      const hashed = await baseline("a.bin", 1, true);
      await edit("a.bin", "BBBB");
      expect(await hasLocalChanges(full("a.bin"), plain)).toBe(true);
      expect(await hasLocalChanges(full("a.bin"), hashed)).toBe(true);
    });

    it("is false when only the mtime changed and a hash proves the content did not", async () => {
      await put("a.txt", "hello");
      const entry = await baseline("a.txt", 1, true);
      await edit("a.txt", "hello");
      expect(await hasLocalChanges(full("a.txt"), entry)).toBe(false);
    });

    it("is true for an untracked file and false for a missing one", async () => {
      await put("untracked.txt", "mine");
      expect(await hasLocalChanges(full("untracked.txt"), undefined)).toBe(
        true,
      );
      expect(await hasLocalChanges(full("missing.txt"), undefined)).toBe(false);
      expect(
        await hasLocalChanges(full("missing.txt"), {
          fileId: "x",
          changelist: 1,
          md5: "",
          size: 1,
        }),
      ).toBe(false);
    });

    it("is false for a directory", async () => {
      await mkdir(full("dir"));
      expect(await hasLocalChanges(full("dir"), undefined)).toBe(false);
    });
  });

  describe("isMergeableText", () => {
    it.each([
      ["plain ASCII", Buffer.from("hello\nworld\n"), true],
      ["UTF-8 with accents and emoji", Buffer.from("café 😀\n"), true],
      ["UTF-8 with a BOM", Buffer.from("﻿hello"), true],
      ["an empty file", Buffer.alloc(0), true],
      ["CRLF line endings", Buffer.from("a\r\nb\r\n"), true],
      ["a NUL byte", Buffer.from([0x61, 0x00, 0x62]), false],
      ["Latin-1 bytes", Buffer.from([0x63, 0x61, 0x66, 0xe9]), false],
      ["UTF-16", Buffer.from("hello", "utf16le"), false],
      ["a truncated UTF-8 sequence", Buffer.from([0x61, 0xe2, 0x82]), false],
      [
        "PNG header",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        false,
      ],
    ])("%s", (_name, bytes, expected) => {
      expect(isMergeableText(bytes)).toBe(expected);
    });
  });

  describe("protect", () => {
    it("does not copy a file with no local changes", async () => {
      await put("clean.txt", "as pulled");
      const guard = new LocalChangeGuard(root, "cl2");

      expect(
        await guard.protect(
          "clean.txt",
          "modified",
          await baseline("clean.txt"),
        ),
      ).toBe(false);
      expect(guard.files).toEqual([]);
      expect(await backupCount()).toBe(0);
    });

    it("copies a locally changed file, keeping its directory layout", async () => {
      await put("dir/sub/a.txt", "base");
      const entry = await baseline("dir/sub/a.txt", 7);
      await edit("dir/sub/a.txt", "mine");
      const guard = new LocalChangeGuard(root, "cl9");

      expect(await guard.protect("dir/sub/a.txt", "modified", entry)).toBe(
        true,
      );

      const [file] = guard.files;
      expect(file!.baseCl).toBe(7);
      expect(file!.backupPath).toContain(
        path.join(".checkpoint", "pull-backups"),
      );
      expect(file!.backupPath.endsWith(path.join("dir", "sub", "a.txt"))).toBe(
        true,
      );
      expect(await readFile(file!.backupPath, "utf8")).toBe("mine");
    });

    it("does not copy a file that is not there", async () => {
      const guard = new LocalChangeGuard(root, "cl2");
      expect(await guard.protect("missing.txt", "added", undefined)).toBe(
        false,
      );
    });
  });

  describe("after the pull", () => {
    it("merges text changed on both sides and keeps both changes", async () => {
      const base = "one\ntwo\nthree\nfour\nfive\n";
      await put("f.txt", base);
      const entry = await baseline("f.txt");
      await edit("f.txt", "ONE\ntwo\nthree\nfour\nfive\n");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("f.txt", "modified", entry);

      const theirs = "one\ntwo\nthree\nfour\nFIVE\n";
      await put("f.txt", theirs); // the pull

      const result = await guard.resolve(noBinary, baseOf(base));

      expect(await readFile(full("f.txt"), "utf8")).toBe(
        "ONE\ntwo\nthree\nfour\nFIVE\n",
      );
      expect(result.setAside).toEqual([]);
      expect(result.merged.length).toBe(1);
      expect(result.merged[0]!.clean).toBe(true);
      // The recorded baseline is the server's version, so the merged file
      // (which holds a local edit) still shows as locally changed.
      expect(result.merged[0]!.incoming.md5).toBe(md5(theirs));
      expect(result.merged[0]!.incoming.size).toBe(Buffer.byteLength(theirs));
      // A clean merge contains everything; its backup is not kept.
      expect(await backupCount()).toBe(0);
    });

    it("leaves conflict markers and keeps the backup when the same lines changed", async () => {
      await put("f.txt", "line\n");
      const entry = await baseline("f.txt");
      await edit("f.txt", "mine\n");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("f.txt", "modified", entry);
      await put("f.txt", "theirs\n");

      const result = await guard.resolve(noBinary, baseOf("line\n"));

      const merged = await readFile(full("f.txt"), "utf8");
      expect(merged).toContain("<<<<<<< CURRENT");
      expect(merged).toContain("mine");
      expect(merged).toContain("theirs");
      expect(result.merged[0]!.clean).toBe(false);
      expect(await readFile(guard.files[0]!.backupPath, "utf8")).toBe("mine\n");
    });

    it("keeps the server's binary and sets the local one aside", async () => {
      const mine = Buffer.from([1, 2, 3, 4, 250, 251]);
      const theirs = Buffer.from([9, 9, 9, 9, 9, 9, 9]);
      await put("asset.uasset", Buffer.from([0, 0, 0, 0, 0, 0]));
      const entry = await baseline("asset.uasset");
      await edit("asset.uasset", mine);
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("asset.uasset", "modified", entry);
      await put("asset.uasset", theirs);

      const result = await guard.resolve(allBinary, noBase);

      expect((await readFile(full("asset.uasset"))).equals(theirs)).toBe(true);
      expect(result.merged).toEqual([]);
      expect(result.setAside.length).toBe(1);
      expect(result.setAside[0]!.reason).toBe("binary");
      expect(
        (await readFile(result.setAside[0]!.backupPath)).equals(mine),
      ).toBe(true);
    });

    it("sets aside a same-size binary edit", async () => {
      await put("tex.bin", "AAAA");
      const entry = await baseline("tex.bin");
      await edit("tex.bin", "BBBB");
      const guard = new LocalChangeGuard(root, "cl2");
      expect(await guard.protect("tex.bin", "modified", entry)).toBe(true);
      await put("tex.bin", "CCCC");

      const result = await guard.resolve(allBinary, noBase);

      expect(result.setAside[0]!.reason).toBe("binary");
      expect(await readFile(result.setAside[0]!.backupPath, "utf8")).toBe(
        "BBBB",
      );
    });

    it.each([
      ["Latin-1", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])],
      ["UTF-16", Buffer.from("local edit\n", "utf16le")],
      ["text with a NUL", Buffer.from([0x61, 0x00, 0x62, 0x0a])],
    ])(
      "does not decode and rewrite a text-named file that is really %s",
      async (_name, mine) => {
        await put("notes.txt", "base\n");
        const entry = await baseline("notes.txt");
        await edit("notes.txt", mine);
        const guard = new LocalChangeGuard(root, "cl2");
        await guard.protect("notes.txt", "modified", entry);
        await put("notes.txt", "theirs\n");

        const result = await guard.resolve(noBinary, noBase);

        expect(result.setAside[0]!.reason).toBe("not-text");
        expect(
          (await readFile(result.setAside[0]!.backupPath)).equals(mine),
        ).toBe(true);
        expect(await readFile(full("notes.txt"), "utf8")).toBe("theirs\n");
      },
    );

    it("sets the local file aside when the server's version is not text", async () => {
      await put("f.txt", "base\n");
      const entry = await baseline("f.txt");
      await edit("f.txt", "mine\n");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("f.txt", "modified", entry);
      const theirs = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
      await put("f.txt", theirs);

      const result = await guard.resolve(noBinary, noBase);

      expect(result.setAside[0]!.reason).toBe("not-text");
      expect((await readFile(full("f.txt"))).equals(theirs)).toBe(true);
      expect(await readFile(result.setAside[0]!.backupPath, "utf8")).toBe(
        "mine\n",
      );
    });

    it("keeps the local edit when the base cannot be read", async () => {
      // This used to be the end of the edit: the merge threw, the error was
      // logged, and the only copy of the local text was a variable.
      await put("f.txt", "base\n");
      const entry = await baseline("f.txt");
      await edit("f.txt", "mine\n");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("f.txt", "modified", entry);
      await put("f.txt", "theirs\n");

      const result = await guard.resolve(noBinary, async () => {
        throw new Error("storage unreachable");
      });

      expect(result.merged).toEqual([]);
      expect(result.setAside[0]!.reason).toBe("merge-failed");
      expect(await readFile(result.setAside[0]!.backupPath, "utf8")).toBe(
        "mine\n",
      );
      expect(await readFile(full("f.txt"), "utf8")).toBe("theirs\n");
    });

    it("sets aside a local edit to a file the server deleted", async () => {
      await put("gone.txt", "base\n");
      const entry = await baseline("gone.txt");
      await edit("gone.txt", "my unsubmitted work\n");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("gone.txt", "removed", entry);
      await rm(full("gone.txt")); // the pull

      const result = await guard.resolve(noBinary, noBase);

      expect(existsSync(full("gone.txt"))).toBe(false);
      expect(result.setAside[0]!.reason).toBe("deleted-on-server");
      expect(await readFile(result.setAside[0]!.backupPath, "utf8")).toBe(
        "my unsubmitted work\n",
      );
    });

    it("sets aside an untracked file the server added under the same name", async () => {
      await put("new.txt", "my untracked notes\n");
      const guard = new LocalChangeGuard(root, "cl2");
      expect(await guard.protect("new.txt", "added", undefined)).toBe(true);
      await put("new.txt", "their new file\n");

      const result = await guard.resolve(noBinary, noBase);

      expect(result.setAside[0]!.reason).toBe("no-common-base");
      expect(await readFile(full("new.txt"), "utf8")).toBe("their new file\n");
      expect(await readFile(result.setAside[0]!.backupPath, "utf8")).toBe(
        "my untracked notes\n",
      );
    });

    it("reports nothing when the local change was the same change", async () => {
      await put("f.txt", "base\n");
      const entry = await baseline("f.txt");
      await edit("f.txt", "the fix\n");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("f.txt", "modified", entry);
      await put("f.txt", "the fix\n");

      const result = await guard.resolve(allBinary, noBase);

      expect(result).toEqual({ merged: [], setAside: [] });
      expect(await backupCount()).toBe(0);
    });

    it("reports nothing when the pull did not touch the file after all", async () => {
      await put("skipped.bin", "base");
      const entry = await baseline("skipped.bin");
      await edit("skipped.bin", "mine");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("skipped.bin", "modified", entry);
      await guard.protect("skipped.bin", "removed", entry);

      const result = await guard.resolve(allBinary, noBase);

      expect(result).toEqual({ merged: [], setAside: [] });
      expect(await readFile(full("skipped.bin"), "utf8")).toBe("mine");
      expect(await backupCount()).toBe(0);
    });

    it("puts the local file back if the pull removed it without replacing it", async () => {
      await put("f.bin", "base");
      const entry = await baseline("f.bin");
      await edit("f.bin", "mine");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("f.bin", "modified", entry);
      await rm(full("f.bin"));

      await guard.resolve(allBinary, noBase);

      expect(await readFile(full("f.bin"), "utf8")).toBe("mine");
    });

    it("settles many files independently", async () => {
      const guard = new LocalChangeGuard(root, "cl2");
      const entries: Record<string, WorkspaceStateFile> = {};
      for (const name of ["a.txt", "b.bin", "c.txt", "d.bin"]) {
        await put(name, "base\n");
        entries[name] = await baseline(name);
      }
      await edit("a.txt", "mine-a\nbase\n");
      await edit("b.bin", "mine-b");
      await edit("c.txt", "mine-c\n");
      // d.bin has no local changes.
      for (const name of ["a.txt", "b.bin", "c.txt", "d.bin"]) {
        await guard.protect(name, "modified", entries[name]);
      }
      expect(guard.files.map((f) => f.relativePath)).toEqual([
        "a.txt",
        "b.bin",
        "c.txt",
      ]);

      await put("a.txt", "base\ntheirs-a\n");
      await put("b.bin", "theirs-b");
      await put("c.txt", "theirs-c\n");
      await put("d.bin", "theirs-d");

      const result = await guard.resolve(
        (p) => p.endsWith(".bin"),
        async (p) => Buffer.from(p === "a.txt" ? "base\n" : "base\n"),
      );

      expect(result.merged.map((m) => [m.relativePath, m.clean])).toEqual([
        ["a.txt", true],
        ["c.txt", false],
      ]);
      expect(result.setAside.map((s) => [s.relativePath, s.reason])).toEqual([
        ["b.bin", "binary"],
      ]);
      expect(await readFile(full("a.txt"), "utf8")).toBe(
        "mine-a\nbase\ntheirs-a\n",
      );
      expect(await readFile(full("d.bin"), "utf8")).toBe("theirs-d");
    });
  });

  describe("putBack", () => {
    it("restores one local file over whatever the pull wrote and drops its backup", async () => {
      await put("stray.txt", "my untracked file");
      await put("other.txt", "base");
      const otherEntry = await baseline("other.txt");
      await edit("other.txt", "mine");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("stray.txt", "added", undefined);
      await guard.protect("other.txt", "modified", otherEntry);

      await put("stray.txt", "written by an index that should not have");

      expect(await guard.putBack("stray.txt")).toBe(true);

      expect(await readFile(full("stray.txt"), "utf8")).toBe(
        "my untracked file",
      );
      expect(guard.files.map((f) => f.relativePath)).toEqual(["other.txt"]);
      expect(await backupCount()).toBe(1);
    });

    it("recreates the file if the correction removed it", async () => {
      await put("dir/stray.txt", "mine");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("dir/stray.txt", "added", undefined);
      await rm(full("dir"), { recursive: true });

      expect(await guard.putBack("dir/stray.txt")).toBe(true);
      expect(await readFile(full("dir/stray.txt"), "utf8")).toBe("mine");
      expect(await backupCount()).toBe(0);
    });

    it("returns false for a path it did not back up", async () => {
      const guard = new LocalChangeGuard(root, "cl2");
      expect(await guard.putBack("never-protected.txt")).toBe(false);
    });
  });

  describe("when the pull fails", () => {
    it("puts every local version back and leaves no backups", async () => {
      await put("a.txt", "base-a");
      await put("dir/b.bin", "base-b");
      await put("gone.txt", "base-c");
      const a = await baseline("a.txt");
      const b = await baseline("dir/b.bin");
      const c = await baseline("gone.txt");
      await edit("a.txt", "mine-a");
      await edit("dir/b.bin", "mine-b");
      await edit("gone.txt", "mine-c");

      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("a.txt", "modified", a);
      await guard.protect("dir/b.bin", "modified", b);
      await guard.protect("gone.txt", "removed", c);

      // The pull got partway and died.
      await put("a.txt", "theirs-a");
      await rm(full("gone.txt"));

      await guard.restoreAll();

      expect(await readFile(full("a.txt"), "utf8")).toBe("mine-a");
      expect(await readFile(full("dir/b.bin"), "utf8")).toBe("mine-b");
      expect(await readFile(full("gone.txt"), "utf8")).toBe("mine-c");
      expect(await backupCount()).toBe(0);
    });

    it("carries on past a file it cannot put back, and says where its local version is", async () => {
      // On Windows, a file the Unreal Editor holds can be read but not
      // written, so putting its backup back fails like the pull did. That
      // must not stop the files after it from going back.
      await put("first.uasset", "base-1");
      await put("second.txt", "base-2");
      const first = await baseline("first.uasset");
      const second = await baseline("second.txt");
      await edit("first.uasset", "mine-1");
      await edit("second.txt", "mine-2");

      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("first.uasset", "modified", first);
      await guard.protect("second.txt", "modified", second);
      await put("first.uasset", "theirs-1");
      await put("second.txt", "theirs-2");
      // A directory where the file was: copyFile onto it fails.
      await rm(full("first.uasset"));
      await mkdir(full("first.uasset"));

      const result = await guard.restoreAll();

      expect(await readFile(full("second.txt"), "utf8")).toBe("mine-2");
      expect(result.restored).toEqual(["second.txt"]);
      expect(result.failed.map((f) => f.relativePath)).toEqual([
        "first.uasset",
      ]);
      expect(await readFile(result.failed[0]!.backupPath, "utf8")).toBe(
        "mine-1",
      );
      expect(describeFailedPull("Pull failed: boom", result)).toContain(
        result.failed[0]!.backupPath,
      );
    });

    it("leaves alone a file the pull never got to write", async () => {
      // Its content is still the local version, so nothing is copied, which
      // is what lets a file that can be read but not written count as
      // restored.
      await put("held.uasset", "base");
      const entry = await baseline("held.uasset");
      await edit("held.uasset", "mine");
      const guard = new LocalChangeGuard(root, "cl2");
      await guard.protect("held.uasset", "modified", entry);
      const before = (await stat(full("held.uasset"))).mtimeMs;

      const result = await guard.restoreAll();

      expect(result).toEqual({ restored: ["held.uasset"], failed: [] });
      expect((await stat(full("held.uasset"))).mtimeMs).toBe(before);
      expect(await backupCount()).toBe(0);
    });
  });

  describe("text merge", () => {
    it("keeps CRLF line endings", () => {
      const base = "one\r\ntwo\r\nthree\r\n";
      const mine = "ONE\r\ntwo\r\nthree\r\n";
      const theirs = "one\r\ntwo\r\nTHREE\r\n";

      const merged = autoMergeText(base, mine, theirs);

      expect(merged.clean).toBe(true);
      expect(merged.content).toBe("ONE\r\ntwo\r\nTHREE\r\n");
    });

    it("keeps LF line endings", () => {
      const merged = autoMergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
      expect(merged.content).toBe("A\nb\nC\n");
    });

    it("keeps a missing final newline missing", () => {
      const merged = autoMergeText("a\nb\nc", "A\nb\nc", "a\nb\nc");
      expect(merged.content).toBe("A\nb\nc");
    });

    it("returns the local text when only it changed, and the incoming text when only it did", () => {
      expect(autoMergeText("a\nb\n", "a\nX\n", "a\nb\n").content).toBe(
        "a\nX\n",
      );
      expect(autoMergeText("a\nb\n", "a\nb\n", "a\nY\n").content).toBe(
        "a\nY\n",
      );
    });

    it("marks a conflict when both changed the same line", () => {
      const merged = autoMergeText("a\n", "mine\n", "theirs\n");
      expect(merged.clean).toBe(false);
      expect(merged.content).toContain("mine");
      expect(merged.content).toContain("theirs");
    });
  });
});
