/**
 * What the native pull reports it wrote (src/core/daemon/src/util/
 * pull-record.ts): each file's size and mtime as its write finished, read back
 * so the pull records those as the baseline instead of a stat taken when it
 * returns (DL-21). The mtime must come out exactly as Node's fs.stat would
 * report it, or every pulled file would look edited.
 */
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearPullRecord,
  takePullRecord,
  type WrittenFile,
} from "../../../core/daemon/src/util/pull-record.js";

describe("the native pull record", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chk-pull-record-"));
    await mkdir(path.join(root, ".checkpoint"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const recordFile = () => path.join(root, ".checkpoint", "pull-written.tsv");

  it("reads each file's size, mtime (as Node reports it), and mode, then removes the record", async () => {
    await writeFile(path.join(root, "a.txt"), "hello");
    const st = await stat(path.join(root, "a.txt"), { bigint: true });
    const ns = st.mtimeNs;
    await writeFile(
      recordFile(),
      `a.txt\t5\t${ns / 1_000_000_000n}\t${ns % 1_000_000_000n}\t755\n` +
        `Docs/b.txt\t0\t1700000000\t123456789\t-\n`,
    );

    const into = new Map<string, WrittenFile>();
    expect(await takePullRecord(root, into)).toBe(true);

    expect(into.get("a.txt")).toEqual({
      size: 5,
      mtimeMs: (await stat(path.join(root, "a.txt"))).mtimeMs,
      mode: 0o755,
    });
    expect(into.get("Docs/b.txt")).toEqual({
      size: 0,
      mtimeMs: 1700000000 * 1e3 + 123456789 / 1e6,
    });
    expect(existsSync(recordFile())).toBe(false);
  });

  it("reads the md5 the addon took as it wrote each file, and none where it could not vouch for one", async () => {
    const hash = "5d41402abc4b2a76b9719d911017c592"; // md5("hello")
    await writeFile(
      recordFile(),
      `a.txt\t5\t10\t0\t-\t${hash}\n` +
        `b.txt\t5\t10\t0\t644\t-\n` +
        // Not a hash this daemon can compare with: treated as unknown.
        `c.txt\t5\t10\t0\t-\t5D41402ABC4B2A76B9719D911017C592\n` +
        `d.txt\t5\t10\t0\t-\t\n` +
        `e.txt\t5\t10\t0\t755\t${hash}\n`,
    );
    const into = new Map<string, WrittenFile>();
    expect(await takePullRecord(root, into)).toBe(true);
    expect(into.get("a.txt")).toEqual({ size: 5, mtimeMs: 10_000, md5: hash });
    expect(into.get("b.txt")).toEqual({
      size: 5,
      mtimeMs: 10_000,
      mode: 0o644,
    });
    expect(into.get("c.txt")).toEqual({ size: 5, mtimeMs: 10_000 });
    expect(into.get("d.txt")).toEqual({ size: 5, mtimeMs: 10_000 });
    expect(into.get("e.txt")).toEqual({
      size: 5,
      mtimeMs: 10_000,
      mode: 0o755,
      md5: hash,
    });
  });

  it("reads records from addons that write no md5 column, or no mode column", async () => {
    await writeFile(
      recordFile(),
      `a.txt\t5\t10\t0\t755\n` + `b.txt\t5\t10\t0\n`,
    );
    const into = new Map<string, WrittenFile>();
    expect(await takePullRecord(root, into)).toBe(true);
    expect(into.get("a.txt")).toEqual({
      size: 5,
      mtimeMs: 10_000,
      mode: 0o755,
    });
    expect(into.get("b.txt")).toEqual({ size: 5, mtimeMs: 10_000 });
  });

  it("drops an earlier pass's md5 when a later pass rewrites the file without one", async () => {
    const into = new Map<string, WrittenFile>();
    await writeFile(
      recordFile(),
      "a.txt\t1\t10\t0\t-\t0cc175b9c0f1b6a831c399e269772661\n",
    );
    await takePullRecord(root, into);
    await writeFile(recordFile(), "a.txt\t2\t20\t0\t-\t-\n");
    await takePullRecord(root, into);
    expect(into.get("a.txt")).toEqual({ size: 2, mtimeMs: 20_000 });
  });

  it("reports no record when the addon wrote none (an older addon)", async () => {
    const into = new Map<string, WrittenFile>();
    expect(await takePullRecord(root, into)).toBe(false);
    expect(into.size).toBe(0);
  });

  it("lets a later pass's record win for a file written twice", async () => {
    const into = new Map<string, WrittenFile>();
    await writeFile(recordFile(), "a.txt\t1\t10\t0\t-\n");
    await takePullRecord(root, into);
    await writeFile(recordFile(), "a.txt\t2\t20\t0\t-\n");
    await takePullRecord(root, into);
    expect(into.get("a.txt")).toEqual({ size: 2, mtimeMs: 20_000 });
  });

  it("clears a record left by an earlier pass", async () => {
    await writeFile(recordFile(), "stale\t1\t1\t0\t-\n");
    await clearPullRecord(root);
    expect(existsSync(recordFile())).toBe(false);
  });
});
