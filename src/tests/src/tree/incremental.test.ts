// Incremental tree updates must produce exactly the tree a full rebuild does.
//
// A submit used to rebuild the whole tree from the parent's full path map and
// write every block. applyChanges re-encodes only the directories on the
// edited paths. The tree is canonical (its blocks are a function of its
// contents), so anything other than the rebuild's exact root would quietly
// lose sharing and hash-skipping diffs; these tests hold it to that, at tiny
// budgets where every inline/ref/demotion/chunking rule fires constantly.

import { describe, expect, it } from "vitest";
import {
  applyChanges,
  buildTree,
  listDir,
  lookup,
  materialize,
  MemBlockStore,
  newTreeOpStats,
  TreeCollisionError,
  type BlockStore,
  type Hash,
  type StateMap,
  type TreeEdit,
} from "~/server/tree/tree";
import { encodeNode, NODE_LEAF, KIND_FILE } from "~/server/tree/codec";

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

/** Full rebuild into a fresh store: the reference answer. */
async function rebuild(map: StateMap, budget: number): Promise<Hash> {
  return buildTree(map.entries(), new MemBlockStore(), budget);
}

/** Every block reachable from a root is in the store (materialize reads them all). */
async function assertComplete(root: Hash, store: BlockStore) {
  await materialize(root, store);
}

const DIRS = [
  "a", "a/b", "a/b/c", "a/bb", "ab", "Content/__ExternalActors__/Map/0",
  "Content/__ExternalActors__/Map/1", "Content/__ExternalActors__/Map/2",
  "Source/Game", "Source/Game/Private", "dense", "Ä/ö", "x/y/z/w/v",
];

function randomEdits(rand: () => number, map: StateMap, step: number): TreeEdit[] {
  const edits: TreeEdit[] = [];
  const n = 1 + Math.floor(rand() * 6);
  const existing = [...map.keys()];
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.45 || existing.length === 0) {
      const dir = DIRS[Math.floor(rand() * DIRS.length)]!;
      const name = dir === "dense"
        ? `f${String(Math.floor(rand() * 400)).padStart(4, "0")}.uasset`
        : `file${Math.floor(rand() * 30)}.txt`;
      edits.push({ path: `${dir}/${name}`, cl: step });
    } else if (r < 0.7) {
      edits.push({ path: existing[Math.floor(rand() * existing.length)]!, cl: step });
    } else if (r < 0.95) {
      edits.push({ path: existing[Math.floor(rand() * existing.length)]!, delete: true });
    } else {
      // Delete a whole directory's worth of files.
      const dir = DIRS[Math.floor(rand() * DIRS.length)]!;
      for (const p of existing) {
        if (p.startsWith(`${dir}/`)) edits.push({ path: p, delete: true });
      }
    }
  }
  return edits;
}

/** Apply edits to a map the way the tree should, skipping would-be collisions. */
function applyToMap(map: StateMap, edits: TreeEdit[]): StateMap {
  const next = new Map(map);
  for (const e of edits) {
    if (e.delete) next.delete(e.path);
    else next.set(e.path, e.cl);
  }
  return next;
}

function collides(map: StateMap): boolean {
  const dirs = new Set<string>();
  for (const p of map.keys()) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const p of map.keys()) if (dirs.has(p)) return true;
  return false;
}

describe("applyChanges", () => {
  for (const budget of [256, 300, 1024, 4096, 128 * 1024]) {
    for (const seed of [1, 2, 3]) {
      it(`matches a full rebuild over 120 random edit batches (budget ${budget}, seed ${seed})`, async () => {
        const rand = rng(seed * 1000 + budget);
        const store = new MemBlockStore();
        let map: StateMap = new Map();
        let root = await buildTree(map.entries(), store, budget);

        for (let step = 1; step <= 120; step++) {
          const edits = randomEdits(rand, map, step);
          const nextMap = applyToMap(map, edits);
          if (collides(nextMap)) continue; // covered by the collision tests

          const next = await applyChanges(root, edits, store, budget);

          expect(next, `step ${step}`).toBe(await rebuild(nextMap, budget));
          expect(await materialize(next, store)).toEqual(nextMap);

          // No redundant writes: starting from a store holding exactly the
          // parent tree, the update adds the same blocks a full build of the
          // new map would add to that store.
          const parentOnly = new MemBlockStore();
          await buildTree(map.entries(), parentOnly, budget);
          const before = parentOnly.size;
          const stats = newTreeOpStats();
          await applyChanges(root, edits, parentOnly, budget, stats);
          const reference = new MemBlockStore();
          await buildTree(map.entries(), reference, budget);
          await buildTree(nextMap.entries(), reference, budget);
          expect(parentOnly.size - before, `new blocks at step ${step}`).toBe(
            reference.size - before,
          );
          expect(stats.blocksPut).toBe(parentOnly.size - before);

          map = nextMap;
          root = next;
        }
        await assertComplete(root, store);
      });
    }
  }

  it("deleting everything gives the empty tree, and building back up works", async () => {
    const store = new MemBlockStore();
    const map: StateMap = new Map(
      Array.from({ length: 300 }, (_, i) => [`d${i % 7}/sub${i % 3}/f${i}`, i] as [string, number]),
    );
    const root = await buildTree(map.entries(), store, 256);
    const empty = await applyChanges(
      root,
      [...map.keys()].map((path) => ({ path, delete: true })),
      store,
      256,
    );
    expect(empty).toBe(await rebuild(new Map(), 256));
    const again = await applyChanges(empty, [...map].map(([path, cl]) => ({ path, cl })), store, 256);
    expect(again).toBe(root);
  });

  it("builds from nothing exactly like buildTree", async () => {
    const map: StateMap = new Map(
      Array.from({ length: 500 }, (_, i) => [`dense/f${String(i).padStart(5, "0")}`, i] as [string, number]),
    );
    const store = new MemBlockStore();
    const root = await applyChanges(null, [...map].map(([path, cl]) => ({ path, cl })), store, 256);
    expect(root).toBe(await rebuild(map, 256));
  });

  it("normalizes paths the way the full build does", async () => {
    const store = new MemBlockStore();
    const root = await applyChanges(null, [{ path: "a//b/c.txt", cl: 1 }, { path: "/d.txt", cl: 2 }], store, 256);
    expect(await materialize(root, store)).toEqual(new Map([["a/b/c.txt", 1], ["d.txt", 2]]));
  });

  it("treats deleting a path that is not a file as a no-op", async () => {
    const store = new MemBlockStore();
    const root = await buildTree([["a/b.txt", 1]], store, 256);
    expect(await applyChanges(root, [{ path: "missing.txt", delete: true }], store, 256)).toBe(root);
    expect(await applyChanges(root, [{ path: "a", delete: true }], store, 256)).toBe(root);
    expect(await applyChanges(root, [{ path: "nope/deeper/x", delete: true }], store, 256)).toBe(root);
  });

  it("refuses to make a path both a file and a directory", async () => {
    const store = new MemBlockStore();
    const root = await buildTree([["a/b.txt", 1], ["f", 1]], store, 256);
    await expect(applyChanges(root, [{ path: "f/x", cl: 2 }], store, 256)).rejects.toBeInstanceOf(TreeCollisionError);
    await expect(applyChanges(root, [{ path: "a", cl: 2 }], store, 256)).rejects.toBeInstanceOf(TreeCollisionError);
    await expect(
      applyChanges(null, [{ path: "n", cl: 1 }, { path: "n/m", cl: 1 }], store, 256),
    ).rejects.toBeInstanceOf(TreeCollisionError);
  });

  it("allows replacing a file with a directory (and back) in one batch", async () => {
    const store = new MemBlockStore();
    const root = await buildTree([["f", 1], ["a/b.txt", 1]], store, 256);
    const toDir = await applyChanges(root, [{ path: "f", delete: true }, { path: "f/x", cl: 2 }], store, 256);
    expect(toDir).toBe(await rebuild(new Map([["f/x", 2], ["a/b.txt", 1]]), 256));
    const toFile = await applyChanges(toDir, [{ path: "f/x", delete: true }, { path: "f", cl: 3 }], store, 256);
    expect(toFile).toBe(await rebuild(new Map([["f", 3], ["a/b.txt", 1]]), 256));
  });

  it("reads a legacy node with a duplicated name without losing either side", async () => {
    // Trees built from a map holding both "a" and "a/b" carry two file
    // entries named "a". Updating elsewhere in such a tree must not throw.
    const store = new MemBlockStore();
    const payload = encodeNode(NODE_LEAF, [
      { name: "a", kind: KIND_FILE, cl: 1 },
      { name: "a", kind: KIND_FILE, cl: 1 },
      { name: "z", kind: KIND_FILE, cl: 1 },
    ]);
    const root = await store.put(payload);
    const next = await applyChanges(root, [{ path: "z", cl: 2 }], store, 256);
    expect(await materialize(next, store)).toEqual(new Map([["a", 1], ["z", 2]]));
  });
});

describe("applyChanges reads and writes only what the edit touches", () => {
  async function bigTree(files: number) {
    const map: StateMap = new Map();
    for (let i = 0; i < files; i++) {
      map.set(`Content/Area${i % 40}/Sub${i % 13}/asset_${i}.uasset`, 1);
    }
    const store = new MemBlockStore();
    const root = await buildTree(map.entries(), store, 128 * 1024);
    return { map, store, root };
  }

  /** A store that knows every block's length, like the TreeBlockLength table. */
  function knowingLengths(store: MemBlockStore): BlockStore {
    return {
      put: (b) => store.put(b),
      get: (h) => store.get(h),
      lengths: async (hashes) => {
        const out = new Map<Hash, number>();
        for (const h of hashes) out.set(h, (await store.get(h)).length);
        return out;
      },
    };
  }

  it.each([10_000, 100_000])("a one-file edit in a %i-file tree reads and writes a handful of blocks", async (files) => {
    const { map, store, root } = await bigTree(files);
    const path = [...map.keys()][Math.floor(files / 2)]!;
    const stats = newTreeOpStats();
    const next = await applyChanges(root, [{ path, cl: 2 }], knowingLengths(store), 128 * 1024, stats);
    expect(stats.blocksPut).toBeLessThanOrEqual(8);
    expect(stats.blocksFetched).toBeLessThanOrEqual(12);
    expect(stats.siblingFetches).toBe(0);
    expect(next).toBe(await rebuild(new Map([...map, [path, 2]]), 128 * 1024));
  });

  it("without known lengths, fetches siblings only to learn their size and still writes little", async () => {
    const { map, store, root } = await bigTree(20_000);
    const path = [...map.keys()][7]!;
    const stats = newTreeOpStats();
    const next = await applyChanges(root, [{ path, cl: 3 }], store, 128 * 1024, stats);
    expect(stats.blocksPut).toBeLessThanOrEqual(8);
    expect(stats.siblingFetches).toBeGreaterThan(0);
    expect(next).toBe(await rebuild(new Map([...map, [path, 3]]), 128 * 1024));
  });
});

describe("lookup and listDir", () => {
  for (const budget of [256, 4096]) {
    it(`agree with the materialized map (budget ${budget})`, async () => {
      const rand = rng(budget);
      const map: StateMap = new Map();
      for (let i = 0; i < 2000; i++) {
        const dir = DIRS[Math.floor(rand() * DIRS.length)]!;
        map.set(`${dir}/f${String(i).padStart(5, "0")}`, i);
      }
      const store = new MemBlockStore();
      const root = await buildTree(map.entries(), store, budget);
      const all = [...map.keys()];

      const asked = [...all.filter((_, i) => i % 37 === 0), "nope", "a/nope", "a", "ab/f99999"];
      const found = await lookup(root, asked, store);
      for (const p of asked) expect(found.get(p), p).toBe(map.get(p));

      // One name in a dense directory reads one chunk, not all of them.
      const one = newTreeOpStats();
      const densePath = all.find((p) => p.startsWith("dense/"))!;
      expect((await lookup(root, [densePath], store, one)).get(densePath)).toBe(map.get(densePath));
      const whole = newTreeOpStats();
      await materialize(root, store);
      await listDir(root, "dense", store, whole);
      expect(one.blocksFetched).toBeLessThanOrEqual(whole.blocksFetched);
      if (budget === 256) expect(one.blocksFetched).toBeLessThan(whole.blocksFetched);

      for (const dir of ["", "a", "a/b", "Content/__ExternalActors__/Map", "dense", "nope"]) {
        const listing = await listDir(root, dir, store);
        const prefix = dir ? `${dir}/` : "";
        const files = all
          .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .map((p) => ({ name: p.slice(prefix.length), cl: map.get(p)! }))
          .sort((x, y) => (x.name < y.name ? -1 : 1));
        const dirs = [...new Set(
          all.filter((p) => p.startsWith(prefix) && p.slice(prefix.length).includes("/"))
            .map((p) => p.slice(prefix.length).split("/")[0]!),
        )].sort();
        if (dir && files.length === 0 && dirs.length === 0) {
          expect(listing, dir).toBeNull();
        } else {
          expect(listing?.files.sort((x, y) => (x.name < y.name ? -1 : 1)), dir).toEqual(files);
          expect(listing?.dirs.sort(), dir).toEqual(dirs);
        }
      }
      expect(await listDir(root, `${all[0]}`, store)).toBeNull(); // a file, not a dir
    });
  }
});
