// Golden vectors: fixed inputs -> exact root hashes. These LOCK the frozen tree
// format (node layout v1, SHA-256, packing/chunking algorithm, 128 KB budget).
// Any change to serialization, the hash, the boundary function, inline/ref
// thresholds, or the budget changes these hashes and fails here loudly. If you
// intend such a change, bump FORMAT_VERSION and regenerate these deliberately.

import { describe, it, expect } from "vitest";
import { buildTree, BLOCK_BUDGET, MemBlockStore, type StateMap } from "~/server/tree/tree";

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

function denseDir(n: number): StateMap {
  const m: StateMap = new Map();
  for (let i = 0; i < n; i++) {
    m.set(`d/f${String(i).padStart(5, "0")}.uasset`, i);
  }
  return m;
}

function chain(): StateMap {
  return new Map([["a/b/c/d/e/f/g/only.uasset", 1]]);
}

async function root(entries: Iterable<[string, number]>, budget: number): Promise<string> {
  return buildTree(entries, new MemBlockStore(), budget);
}

// Locked root hashes (SHA-256, format v1, 128 KB budget). Regenerate ONLY with
// a deliberate FORMAT_VERSION bump.
const GOLDEN = {
  empty: "fb50dc0717ff266cf9baf82b1ce7a1c2ef6d9247859680b11a19fb7077f5f222",
  sample128: "24c4a0f1924dbe5da47c6f98e644935b090ddc0dc84b450ae1ae13d85066d233",
  sample256: "85b41eb6260f2db9ac0f168ad662553b2f2901edad1ace0fc7779a6d8355fa89",
  dense256: "d75595624e72d92e27a8b0bd0b58be939fa1eacb1cf5293d986c6d742c5586c7",
  chain128: "4a3d8b44cd73985a92f27fe2b1327da80138bac6ad86ef69a68696ccf79825e5",
} as const;

describe("tree golden vectors (frozen format)", () => {
  it("BLOCK_BUDGET is the frozen 128 KB", () => {
    expect(BLOCK_BUDGET).toBe(128 * 1024);
  });

  it("empty tree", async () => {
    expect(await root(new Map(), BLOCK_BUDGET)).toBe(GOLDEN.empty);
  });

  it("sample at production budget (single leaf block)", async () => {
    expect(await root(Object.entries(SAMPLE), BLOCK_BUDGET)).toBe(GOLDEN.sample128);
  });

  it("sample at tiny budget (inline/ref/demote/split)", async () => {
    expect(await root(Object.entries(SAMPLE), 256)).toBe(GOLDEN.sample256);
  });

  it("dense directory at tiny budget (chunking + index nodes)", async () => {
    expect(await root(denseDir(200), 256)).toBe(GOLDEN.dense256);
  });

  it("deep thin chain (inlining)", async () => {
    expect(await root(chain(), BLOCK_BUDGET)).toBe(GOLDEN.chain128);
  });
});
