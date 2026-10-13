/**
 * What the daemon believes about a workspace: whether a file has changed
 * since it was pulled, and whether that belief survives being written down.
 *
 * Two things here used to fail silently:
 *
 *   - A file edited in place to the same size, after a pull, was hashed as it
 *     was and that hash adopted as the baseline. The edit never showed as a
 *     pending change, and the next pull overwrote it.
 *   - The JSON state file was written in place, and any failure to read it
 *     (including a file cut short by a crash mid-write) was answered with an
 *     empty state: a workspace that tracks nothing and has synced nothing.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceStateFile } from "@checkpointvcs/common";

import { compareWithBaseline } from "../../../core/daemon/src/util/baseline.js";
import {
  closeAllStateStores,
  getStateStore,
} from "../../../core/daemon/src/util/state-store.js";

describe("compareWithBaseline", () => {
  const entry = (
    overrides: Partial<WorkspaceStateFile> = {},
  ): WorkspaceStateFile => ({
    fileId: "f",
    changelist: 1,
    md5: "",
    size: 100,
    mtime: 1000.5,
    ...overrides,
  });
  const lenient = { whenUnknowable: "unchanged" } as const;
  const strict = { whenUnknowable: "changed" } as const;

  it("is changed when the file is not tracked", () => {
    expect(compareWithBaseline({ size: 1, mtimeMs: 1 }, undefined, lenient)).toBe("changed");
  });

  it("is changed when the size differs, whatever else matches", () => {
    for (const md5 of ["", "abc"]) {
      expect(
        compareWithBaseline({ size: 101, mtimeMs: 1000.5 }, entry({ md5 }), lenient),
      ).toBe("changed");
    }
  });

  it("is unchanged when size and mtime both match", () => {
    for (const md5 of ["", "abc"]) {
      expect(
        compareWithBaseline({ size: 100, mtimeMs: 1000.5 }, entry({ md5 }), strict),
      ).toBe("unchanged");
    }
  });

  it("asks for the hash when the file was written since and a hash was recorded", () => {
    expect(
      compareWithBaseline({ size: 100, mtimeMs: 2000 }, entry({ md5: "abc" }), lenient),
    ).toBe("compare-hash");
  });

  it("asks for the hash when a hash was recorded but no mtime", () => {
    for (const mtime of [undefined, 0]) {
      expect(
        compareWithBaseline(
          { size: 100, mtimeMs: 2000 },
          entry({ md5: "abc", mtime }),
          lenient,
        ),
      ).toBe("compare-hash");
    }
  });

  it("is changed for a same-size file written since, when there is no hash to compare", () => {
    // The case that used to be silently adopted as the new baseline.
    for (const options of [lenient, strict]) {
      expect(
        compareWithBaseline({ size: 100, mtimeMs: 2000 }, entry(), options),
      ).toBe("changed");
    }
  });

  it("notices an mtime that differs by less than a millisecond", () => {
    expect(
      compareWithBaseline({ size: 100, mtimeMs: 1000.5001 }, entry(), lenient),
    ).toBe("changed");
  });

  it("follows the caller when the baseline has neither hash nor mtime", () => {
    // State written by old versions. Change detection must not flag the whole
    // workspace; the pull would rather copy a file it did not need to.
    const legacy = entry({ mtime: undefined });
    expect(compareWithBaseline({ size: 100, mtimeMs: 5 }, legacy, lenient)).toBe("unchanged");
    expect(compareWithBaseline({ size: 100, mtimeMs: 5 }, legacy, strict)).toBe("changed");
  });

  it("treats an empty file like any other", () => {
    const empty = entry({ size: 0, mtime: 7 });
    expect(compareWithBaseline({ size: 0, mtimeMs: 7 }, empty, strict)).toBe("unchanged");
    expect(compareWithBaseline({ size: 0, mtimeMs: 8 }, empty, strict)).toBe("changed");
    expect(compareWithBaseline({ size: 1, mtimeMs: 7 }, empty, strict)).toBe("changed");
  });
});

describe("JSON workspace state store", () => {
  let root: string;
  const statePath = () => path.join(root, ".checkpoint", "state.json");
  const store = () => getStateStore(root, "json");

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chk-state-"));
  });

  afterEach(async () => {
    closeAllStateStores();
    await rm(root, { recursive: true, force: true });
  });

  const sample = {
    changelistNumber: 42,
    files: {
      "dir/a.txt": { fileId: "a", changelist: 40, md5: "", size: 3, mtime: 1.5 },
      "b.bin": { fileId: "b", changelist: 42, md5: "abc", size: 9 },
    },
    markedForAdd: ["new.txt"],
    staged: [],
  };

  it("starts empty for a workspace that has never saved", async () => {
    expect(await store().load()).toEqual({
      changelistNumber: 0,
      files: {},
      markedForAdd: [],
      staged: [],
    });
  });

  it("round-trips what was saved", async () => {
    await store().save(sample as never);
    const loaded = await store().load();
    expect(loaded.changelistNumber).toBe(42);
    expect(loaded.files).toEqual(sample.files);
    expect(loaded.markedForAdd).toEqual(["new.txt"]);
  });

  it("leaves no temporary file behind", async () => {
    await store().save(sample as never);
    await store().save({ ...sample, changelistNumber: 43 } as never);
    expect(await readdir(path.join(root, ".checkpoint"))).toEqual(["state.json"]);
  });

  it.each([
    ["cut short mid-write", '{"changelistNumber": 42, "files": {"a.txt": {"fileId"'],
    ["empty", ""],
    ["not JSON at all", "\u0000\u0001garbage"],
  ])("refuses to treat a state file that is %s as an empty workspace", async (_name, content) => {
    await mkdir(path.dirname(statePath()), { recursive: true });
    await writeFile(statePath(), content);

    await expect(store().load()).rejects.toThrow(/unreadable/);
    // And it does not destroy the evidence.
    expect(await readFile(statePath(), "utf8")).toBe(content);
  });

  it("keeps the previous state when a save cannot complete", async () => {
    await store().save(sample as never);

    // Something that cannot be serialized: the write fails before the rename.
    const circular: Record<string, unknown> = { ...sample };
    circular.self = circular;
    await expect(store().save(circular as never)).rejects.toThrow();

    expect((await store().load()).changelistNumber).toBe(42);
    expect(await readdir(path.join(root, ".checkpoint"))).toEqual(["state.json"]);
  });

  it("is not confused by a temporary file left by a crashed save", async () => {
    await store().save(sample as never);
    await writeFile(`${statePath()}.tmp-99999`, "half a sta");

    expect((await store().load()).changelistNumber).toBe(42);
    await store().save({ ...sample, changelistNumber: 50 } as never);
    expect((await store().load()).changelistNumber).toBe(50);
    expect(existsSync(statePath())).toBe(true);
  });
});
