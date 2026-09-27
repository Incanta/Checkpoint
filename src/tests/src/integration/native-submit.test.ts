/**
 * Edge cases for the native submit's file sizing and path handling, run
 * against the real addon and real services.
 *
 * Background: the addon sizes files by enumerating each parent directory once
 * and matching entries by filename. A path that the scan does not account for
 * used to keep its initial size of 0, and Longtail happily committed it as an
 * empty asset that then overwrote real content on every pull (commit
 * 708b223). The contract these tests pin:
 *
 *   - every non-delete modification is committed with its on-disk bytes;
 *   - the shape of the list (repeats, order, root vs nested, names shared
 *     across directories) does not change what gets committed.
 *
 * Inputs the addon must REJECT rather than commit live in
 * native-submit-rejects.test.ts, in a separate file because a native crash
 * takes the whole vitest worker down with it and would hide every test after it.
 *
 * The daemon deduplicates before calling the addon; these tests call the
 * addon directly so that safety net is not in the way.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { Modification } from "@checkpointvcs/longtail-addon";

import {
  changelistPaths,
  createContext,
  createWorkspace,
  enabled,
  nativeSubmit,
  readCommitted,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

const sha256 = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

const add = (filePath: string): Modification => ({
  path: filePath,
  delete: false,
});
const del = (filePath: string): Modification => ({
  path: filePath,
  delete: true,
});

// Case-insensitive filesystems cannot hold both spellings at once.
const caseSensitiveFs =
  process.platform !== "win32" && process.platform !== "darwin";

describe.skipIf(!enabled)(
  "native submit: file sizing and path handling",
  () => {
    let ctx: IntegrationContext;
    let ws: LocalWorkspace | undefined;

    beforeAll(async () => {
      ctx = await createContext("native-submit");
    });

    afterEach(async () => {
      await ws?.cleanup();
      ws = undefined;
    });

    afterAll(async () => {
      await ws?.cleanup();
    });

    async function expectCommitted(
      changelistNumber: number,
      filePath: string,
      expected: Buffer | string,
    ): Promise<void> {
      const expectedBuffer =
        typeof expected === "string" ? Buffer.from(expected, "utf8") : expected;
      const actual = await readCommitted(ctx, changelistNumber, filePath);
      expect(
        actual.length,
        `${filePath}: committed ${actual.length} bytes, expected ${expectedBuffer.length}`,
      ).toBe(expectedBuffer.length);
      expect(sha256(actual), `${filePath}: committed bytes differ`).toBe(
        sha256(expectedBuffer),
      );
    }

    it("commits the real bytes when the same path is listed more than once", async () => {
      ws = await createWorkspace(ctx, "dup");
      const body = Buffer.from("real content that has to survive the repeat\n");
      await write(ws, "Source/Game.Target.cs", body);
      await write(ws, "Source/GameEditor.Target.cs", "sibling\n");

      const outcome = await nativeSubmit(ctx, ws, [
        add("Source/Game.Target.cs"),
        add("Source/GameEditor.Target.cs"),
        add("Source/Game.Target.cs"),
        add("Source/Game.Target.cs"),
      ]);

      expect(outcome.error, outcome.step).toBe(0);
      const cl = outcome.changelistNumber!;
      await expectCommitted(cl, "Source/Game.Target.cs", body);
      await expectCommitted(cl, "Source/GameEditor.Target.cs", "sibling\n");
    });

    it("commits each file when a filename repeats across directories", async () => {
      ws = await createWorkspace(ctx, "samename");
      const contents: Record<string, string> = {
        "README.md": "root readme\n",
        "Source/README.md": "source readme\n",
        "Source/Game/README.md": "game readme\n",
        "Content/README.md": "content readme\n",
        "Source/Game/Game.cpp": "// game\n",
        "Source/GameEditor/Game.cpp": "// editor shim with the same name\n",
      };
      for (const [filePath, body] of Object.entries(contents)) {
        await write(ws, filePath, body);
      }

      const outcome = await nativeSubmit(
        ctx,
        ws,
        Object.keys(contents).map(add),
      );

      expect(outcome.error, outcome.step).toBe(0);
      for (const [filePath, body] of Object.entries(contents)) {
        await expectCommitted(outcome.changelistNumber!, filePath, body);
      }
    });

    it("commits a legitimately empty file as empty without disturbing its siblings", async () => {
      ws = await createWorkspace(ctx, "empty");
      await write(ws, "Content/Empty.txt", Buffer.alloc(0));
      await write(ws, "Content/Full.txt", "not empty\n");
      await write(ws, "Content/AlsoEmpty.txt", Buffer.alloc(0));

      const outcome = await nativeSubmit(ctx, ws, [
        add("Content/Empty.txt"),
        add("Content/Full.txt"),
        add("Content/AlsoEmpty.txt"),
      ]);

      expect(outcome.error, outcome.step).toBe(0);
      const cl = outcome.changelistNumber!;
      await expectCommitted(cl, "Content/Empty.txt", Buffer.alloc(0));
      await expectCommitted(cl, "Content/AlsoEmpty.txt", Buffer.alloc(0));
      await expectCommitted(cl, "Content/Full.txt", "not empty\n");
    });

    it("sizes root-level and nested files in one submit regardless of list order", async () => {
      ws = await createWorkspace(ctx, "mixed");
      const contents: Record<string, string> = {
        "root.txt": "at the root\n",
        "a/one.txt": "a one\n",
        "b/one.txt": "b one\n",
        "a/two.txt": "a two\n",
        "b/two.txt": "b two\n",
        "a/b/c/deep.txt": "deep\n",
        "other-root.txt": "another root file\n",
      };
      for (const [filePath, body] of Object.entries(contents)) {
        await write(ws, filePath, body);
      }

      // Interleave directories so the grouping by parent has to reorder.
      const order = [
        "a/one.txt",
        "root.txt",
        "b/one.txt",
        "a/b/c/deep.txt",
        "a/two.txt",
        "other-root.txt",
        "b/two.txt",
      ];
      const outcome = await nativeSubmit(ctx, ws, order.map(add));

      expect(outcome.error, outcome.step).toBe(0);
      for (const [filePath, body] of Object.entries(contents)) {
        await expectCommitted(outcome.changelistNumber!, filePath, body);
      }
      const committed = (await changelistPaths(ctx, outcome.changelistNumber!))
        .map((f) => f.path)
        .sort();
      expect(committed).toEqual(Object.keys(contents).sort());
    });

    it("sizes a submitted subset of a large directory, including its first and last entries", async () => {
      ws = await createWorkspace(ctx, "subset");
      const total = 300;
      const contents = new Map<string, string>();
      for (let i = 0; i < total; i++) {
        const name = `Big/f${String(i).padStart(3, "0")}.txt`;
        const body = `file ${i}\n${"x".repeat(i)}\n`;
        contents.set(name, body);
        await write(ws, name, body);
      }
      // The directory scan stops once every requested entry is found, so the
      // subset deliberately includes the first and last names in sort order.
      const submitted = [...contents.keys()].filter(
        (_, i) => i === 0 || i === total - 1 || i % 7 === 0,
      );

      const outcome = await nativeSubmit(ctx, ws, submitted.map(add));

      expect(outcome.error, outcome.step).toBe(0);
      for (const filePath of submitted) {
        await expectCommitted(
          outcome.changelistNumber!,
          filePath,
          contents.get(filePath)!,
        );
      }
      const committed = (await changelistPaths(ctx, outcome.changelistNumber!))
        .map((f) => f.path)
        .sort();
      expect(committed).toEqual([...submitted].sort());
    });

    it("round-trips a file larger than a block byte for byte", async () => {
      ws = await createWorkspace(ctx, "large");
      const large = randomBytes(12 * 1024 * 1024);
      await write(ws, "Content/Movies/Intro.bin", large);
      await write(ws, "Content/Movies/README.md", "movies\n");

      const outcome = await nativeSubmit(ctx, ws, [
        add("Content/Movies/README.md"),
        add("Content/Movies/Intro.bin"),
      ]);

      expect(outcome.error, outcome.step).toBe(0);
      await expectCommitted(
        outcome.changelistNumber!,
        "Content/Movies/Intro.bin",
        large,
      );
      await expectCommitted(
        outcome.changelistNumber!,
        "Content/Movies/README.md",
        "movies\n",
      );
    });

    it("commits names with unicode and spaces intact", async () => {
      ws = await createWorkspace(ctx, "unicode");
      const contents: Record<string, string> = {
        "Content/Näme with spaces.txt": "spaces and umlaut\n",
        "Content/日本語/ファイル.txt": "日本語のテキスト\n",
        "Content/emoji 🎮/level.txt": "emoji directory\n",
      };
      for (const [filePath, body] of Object.entries(contents)) {
        await write(ws, filePath, body);
      }

      const outcome = await nativeSubmit(
        ctx,
        ws,
        Object.keys(contents).map(add),
      );

      expect(outcome.error, outcome.step).toBe(0);
      for (const [filePath, body] of Object.entries(contents)) {
        await expectCommitted(outcome.changelistNumber!, filePath, body);
      }
    });

    it("removes a deleted path from the next version without touching its siblings", async () => {
      ws = await createWorkspace(ctx, "delete");
      await write(ws, "Keep.txt", "keep me\n");
      await write(ws, "Drop.txt", "drop me\n");

      const first = await nativeSubmit(ctx, ws, [
        add("Keep.txt"),
        add("Drop.txt"),
      ]);
      expect(first.error, first.step).toBe(0);

      await rm(path.join(ws.root, "Drop.txt"));
      const second = await nativeSubmit(
        ctx,
        ws,
        [del("Drop.txt")],
        "delete Drop.txt",
      );
      expect(second.error, second.step).toBe(0);
      expect(second.changelistNumber).toBe(first.changelistNumber! + 1);

      const recorded = await changelistPaths(ctx, second.changelistNumber!);
      expect(recorded).toEqual([{ path: "Drop.txt", changeType: "DELETE" }]);
      await expectCommitted(second.changelistNumber!, "Keep.txt", "keep me\n");
      await expect(
        readCommitted(ctx, second.changelistNumber!, "Drop.txt"),
      ).rejects.toThrow();
      // The earlier version still has it.
      await expectCommitted(first.changelistNumber!, "Drop.txt", "drop me\n");
    });

    it.skipIf(!caseSensitiveFs)(
      "keeps files apart whose names differ only by case",
      async () => {
        ws = await createWorkspace(ctx, "case");
        await write(ws, "Dir/Readme.txt", "capital R\n");
        await write(ws, "Dir/readme.txt", "lower r\n");

        const outcome = await nativeSubmit(ctx, ws, [
          add("Dir/Readme.txt"),
          add("Dir/readme.txt"),
        ]);

        expect(outcome.error, outcome.step).toBe(0);
        await expectCommitted(
          outcome.changelistNumber!,
          "Dir/Readme.txt",
          "capital R\n",
        );
        await expectCommitted(
          outcome.changelistNumber!,
          "Dir/readme.txt",
          "lower r\n",
        );
      },
    );
  },
);
