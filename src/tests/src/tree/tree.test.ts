// R1 property + correctness tests for the content-addressed nested directory
// tree. These run with no DB. They guard the invariants that make the format
// safe to freeze: canonical/order-independent layout, materialize == input,
// diff == brute force, structural sharing on edits, thin-chain inlining, and
// correct behavior when subtrees split across blocks (small budget).

import { describe, it, expect } from "vitest";
import {
  buildTree,
  materialize,
  diff,
  MemBlockStore,
  type StateMap,
} from "~/server/tree/tree";

const BIG = 64 * 1024;

function mapOf(obj: Record<string, number>): StateMap {
  return new Map(Object.entries(obj));
}

function shuffle<T>(arr: T[], seed: number): T[] {
  // Deterministic shuffle so the test is stable across runs.
  const a = arr.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const SAMPLE: Record<string, number> = {
  "__ExternalActors__/Maps/MyMap/A/0/actor_aaa.uasset": 1201,
  "__ExternalActors__/Maps/MyMap/A/0/actor_aab.uasset": 1201,
  "__ExternalActors__/Maps/MyMap/A/1/actor_abc.uasset": 1188,
  "__ExternalActors__/Maps/MyMap/B/0/actor_bbb.uasset": 1201,
  "__ExternalActors__/Maps/MyMap/B/3/actor_bcd.uasset": 1042,
  "__ExternalActors__/Maps/MyMap/C/2/actor_cde.uasset": 1199,
  "Source/Titan/Titan.cpp": 900,
  "Source/Titan/Titan.h": 900,
  "Config/DefaultEngine.ini": 5,
};

describe("nested directory tree (R1)", () => {
  it("materialize round-trips the input map", async () => {
    const store = new MemBlockStore();
    const root = await buildTree(mapOf(SAMPLE).entries(), store, BIG);
    const got = await materialize(root, store);
    expect(Object.fromEntries(got)).toEqual(SAMPLE);
  });

  it("is canonical: build order does not change the root hash", async () => {
    const entries = Object.entries(SAMPLE) as [string, number][];
    const s1 = new MemBlockStore();
    const r1 = await buildTree(entries, s1, BIG);
    const s2 = new MemBlockStore();
    const r2 = await buildTree(shuffle(entries, 12345), s2, BIG);
    const s3 = new MemBlockStore();
    const r3 = await buildTree(shuffle(entries, 99), s3, BIG);
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  it("is canonical under split too (tiny budget)", async () => {
    const entries = Object.entries(SAMPLE) as [string, number][];
    const a = new MemBlockStore();
    const ra = await buildTree(entries, a, 256);
    const b = new MemBlockStore();
    const rb = await buildTree(shuffle(entries, 7), b, 256);
    expect(rb).toBe(ra);
    // Round-trips even when subtrees are split across many blocks.
    expect(Object.fromEntries(await materialize(ra, a))).toEqual(SAMPLE);
    expect(a.size).toBeGreaterThan(1); // actually split
  });

  it("insert then remove returns to the identical tree", async () => {
    const base = mapOf(SAMPLE);
    const withExtra = new Map(base);
    withExtra.set("__ExternalActors__/Maps/MyMap/A/0/actor_aad.uasset", 1300);

    const s = new MemBlockStore();
    const rBase = await buildTree(base.entries(), s, BIG);
    const rExtra = await buildTree(withExtra.entries(), s, BIG);
    const rBack = await buildTree(base.entries(), s, BIG);

    expect(rExtra).not.toBe(rBase);
    expect(rBack).toBe(rBase);
  });

  it("diff matches a brute-force map comparison", async () => {
    const a = mapOf(SAMPLE);
    const b = new Map(a);
    b.set("__ExternalActors__/Maps/MyMap/B/0/actor_bbb.uasset", 1205); // modify
    b.delete("Config/DefaultEngine.ini"); // remove
    b.set("Source/Titan/New.cpp", 1206); // add

    const store = new MemBlockStore();
    const ra = await buildTree(a.entries(), store, BIG);
    const rb = await buildTree(b.entries(), store, BIG);
    const d = await diff(ra, rb, store);

    const expectedMod: string[] = [];
    const expectedAdd: string[] = [];
    const expectedRem: string[] = [];
    for (const [k, v] of a) {
      if (!b.has(k)) expectedRem.push(k);
      else if (b.get(k) !== v) expectedMod.push(k);
    }
    for (const k of b.keys()) if (!a.has(k)) expectedAdd.push(k);

    expect(d.added.map((c) => c.path).sort()).toEqual(expectedAdd.sort());
    expect(d.removed.sort()).toEqual(expectedRem.sort());
    expect(d.modified.map((c) => c.path).sort()).toEqual(expectedMod.sort());
  });

  it("shares structure: a one-file edit rewrites few blocks", async () => {
    // Many files with DISTINCT values so subtrees don't all dedup to one block.
    const big: StateMap = new Map();
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 40; y++) {
        big.set(`__ExternalActors__/Maps/M/${x}/${y}/a.uasset`, x * 100 + y);
      }
    }
    const store = new MemBlockStore();
    const rootA = await buildTree(big.entries(), store, 4096);
    const blocksAfterA = store.size;

    const edited = new Map(big);
    edited.set(`__ExternalActors__/Maps/M/20/20/a.uasset`, 999999);
    const before = store.newBlocks;
    const rootB = await buildTree(edited.entries(), store, 4096);
    const newBlocks = store.newBlocks - before;

    expect(rootB).not.toBe(rootA);
    // Re-versioned blocks are O(path-to-root), far fewer than the total.
    expect(newBlocks).toBeLessThan(blocksAfterA / 4);

    const d = await diff(rootA, rootB, store);
    expect(d.modified.map((c) => c.path)).toEqual([
      `__ExternalActors__/Maps/M/20/20/a.uasset`,
    ]);
    expect(d.modified[0]!.cl).toBe(999999);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("chunks a dense directory and round-trips", async () => {
    // One directory with many children, forced to chunk with a small budget.
    const dense: StateMap = new Map();
    for (let i = 0; i < 5000; i++) {
      dense.set(`Content/Materials/Glints/mat_${String(i).padStart(5, "0")}.uasset`, i);
    }
    const s1 = new MemBlockStore();
    const r1 = await buildTree(dense.entries(), s1, 4096);
    expect(s1.size).toBeGreaterThan(2); // split into chunk blocks + index
    expect(Object.fromEntries(await materialize(r1, s1))).toEqual(
      Object.fromEntries(dense),
    );

    // Canonical under chunking: build order does not change the root.
    const entries = [...dense.entries()];
    const s2 = new MemBlockStore();
    const r2 = await buildTree(shuffle(entries, 42), s2, 4096);
    expect(r2).toBe(r1);

    // Editing one file in the dense directory re-versions only a bounded set.
    const edited = new Map(dense);
    edited.set("Content/Materials/Glints/mat_02500.uasset", 999999);
    const before = s1.newBlocks;
    const rEdit = await buildTree(edited.entries(), s1, 4096);
    const churn = s1.newBlocks - before;
    expect(churn).toBeLessThan(s1.size / 3);

    const d = await diff(r1, rEdit, s1);
    expect(d.modified.map((c) => c.path)).toEqual([
      "Content/Materials/Glints/mat_02500.uasset",
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("inlines a deep thin chain into a single block", async () => {
    // One file at the bottom of a deep single-child chain.
    const m: StateMap = new Map([["a/b/c/d/e/f/g/only.uasset", 1]]);
    const store = new MemBlockStore();
    const root = await buildTree(m.entries(), store, BIG);
    expect(store.size).toBe(1); // whole chain collapsed into the root block
    expect(Object.fromEntries(await materialize(root, store))).toEqual({
      "a/b/c/d/e/f/g/only.uasset": 1,
    });
  });
});
