/**
 * The path index that replaced "scan every tracked path" in change detection,
 * checked against the brute-force answers it replaced.
 */
import { describe, expect, it } from "vitest";

import { PathIndex, pathsUnderAny } from "../../../core/daemon/src/util/path-index.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTree(seed: number) {
  const rand = rng(seed);
  const names = ["a", "b", "ab", "a b", "Ä", "c.d", "x"];
  const tracked: Record<string, { fileId: string }> = {};
  for (let i = 0; i < 300; i++) {
    const depth = 1 + Math.floor(rand() * 4);
    const parts = Array.from(
      { length: depth },
      () => names[Math.floor(rand() * names.length)]!,
    );
    const p = parts.join("/") + `/f${i}`;
    tracked[rand() < 0.1 ? `/${p}` : p] = { fileId: `id${i}` };
  }
  return tracked;
}

const strip = (p: string) => p.replace(/^\//, "");

describe("PathIndex", () => {
  it.each([1, 2, 3])("lists files under a directory exactly as a prefix scan would (seed %i)", (seed) => {
    const tracked = randomTree(seed);
    const index = new PathIndex(tracked);
    const all = Object.keys(tracked).map(strip);
    const dirs = new Set<string>([""]);
    for (const p of all) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    // Also directories that do not exist, and prefixes that are not
    // directory boundaries ("a" must not match "ab/...").
    for (const dir of [...dirs, "nope", "a/zz", "a b/c"]) {
      const expected = all
        .filter((p) => dir === "" || p.startsWith(`${dir}/`))
        .sort();
      expect(index.filesUnder(dir).sort(), dir).toEqual(expected);
      expect(index.filesUnder(`${dir}/`).sort(), `${dir}/`).toEqual(expected);
      expect(index.hasTrackedDir(dir)).toBe(dirs.has(dir));
    }
  });

  it("counts ancestors of marked-for-add paths as tracked directories", () => {
    const index = new PathIndex({ "src/a.cpp": { fileId: "1" } }, ["new/deep/file.txt"]);
    expect(index.hasTrackedDir("")).toBe(true);
    expect(index.hasTrackedDir("src")).toBe(true);
    expect(index.hasTrackedDir("new")).toBe(true);
    expect(index.hasTrackedDir("new/deep")).toBe(true);
    expect(index.hasTrackedDir("new/deep/file.txt")).toBe(false);
    expect(index.filesUnder("new")).toEqual([]);
  });

  it("finds a tracked path by file id", () => {
    const index = new PathIndex({ "/a/b.txt": { fileId: "x" }, "c.txt": { fileId: "y" } });
    expect(index.pathOf("x")).toBe("a/b.txt");
    expect(index.pathOf("y")).toBe("c.txt");
    expect(index.pathOf("z")).toBeUndefined();
  });

  it("handles an empty workspace", () => {
    const index = new PathIndex({});
    expect(index.hasTrackedDir("")).toBe(true);
    expect(index.filesUnder("")).toEqual([]);
  });
});

describe("pathsUnderAny", () => {
  it.each([1, 2])("matches a prefix scan over every directory (seed %i)", (seed) => {
    const paths = Object.keys(randomTree(seed)).map(strip);
    const rand = rng(seed + 100);
    const dirs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = paths[Math.floor(rand() * paths.length)]!;
      const parts = p.split("/");
      const cut = 1 + Math.floor(rand() * (parts.length - 1));
      dirs.add(parts.slice(0, cut).join("/") + (rand() < 0.3 ? "/" : ""));
    }
    dirs.add("a"); // must not match "ab/..."

    const expected = paths.filter((p) =>
      [...dirs].some((d) => p.startsWith(d.endsWith("/") ? d : `${d}/`)),
    );
    expect(pathsUnderAny(paths, dirs).sort()).toEqual(expected.sort());
  });
});
