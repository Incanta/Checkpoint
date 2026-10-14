/**
 * The server's in-memory dedup index must answer exactly what the old
 * client-side lookup against the full store.lsi answered: the same blocks,
 * in the same order. Otherwise a submit would upload different blocks (or
 * skip some it should not) than before.
 *
 * Runs the real native addon; needs no services.
 */
import { describe, expect, it } from "vitest";

import {
  getExistingStoreIndex,
  indexCacheAdd,
  indexCacheCreate,
  indexCacheQuery,
  indexCacheSerialize,
  indexCacheStats,
} from "@checkpointvcs/longtail-addon";

import { hashesBuffer, readStoreIndex, writeStoreIndex, type StoreIndexBlock } from "./store-index-format.js";

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

const HASH_ID = 0x626c3300; // any fixed identifier

function randomBlocks(rand: () => number, count: number, pool: bigint[]): StoreIndexBlock[] {
  const blocks: StoreIndexBlock[] = [];
  for (let b = 0; b < count; b++) {
    const n = 1 + Math.floor(rand() * 12);
    const chunks = new Map<bigint, number>();
    for (let c = 0; c < n; c++) {
      // Draw from a shared pool so chunks recur across blocks.
      const hash = pool[Math.floor(rand() * pool.length)]!;
      chunks.set(hash, 1000 + Math.floor(rand() * 60000));
    }
    blocks.push({
      hash: BigInt(Math.floor(rand() * 2 ** 52)) * 4096n + BigInt(b),
      tag: Math.floor(rand() * 4),
      chunks: [...chunks].map(([hash, size]) => ({ hash, size })),
    });
  }
  return blocks;
}

describe("index cache", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`answers like a lookup over the whole index (seed ${seed})`, () => {
      const rand = rng(seed);
      const pool = Array.from({ length: 400 }, (_, i) => BigInt(i + 1) * 0x9e3779b97f4a7c15n % 2n ** 63n);
      const blocks = randomBlocks(rand, 120, pool);
      const full = writeStoreIndex({ hashIdentifier: HASH_ID, blocks });

      // The cache is fed in several segments, as submits would write them,
      // with some blocks repeated across segments.
      const cache = indexCacheCreate();
      let start = 0;
      while (start < blocks.length) {
        const end = Math.min(blocks.length, start + 1 + Math.floor(rand() * 30));
        const repeat = start > 0 ? [blocks[start - 1]!] : [];
        indexCacheAdd(cache, writeStoreIndex({ hashIdentifier: HASH_ID, blocks: [...repeat, ...blocks.slice(start, end)] }));
        start = end;
      }
      expect(indexCacheStats(cache).blocks).toBe(blocks.length);

      for (let q = 0; q < 40; q++) {
        const n = Math.floor(rand() * 80);
        const asked = Array.from({ length: n }, () =>
          rand() < 0.9 ? pool[Math.floor(rand() * pool.length)]! : BigInt(Math.floor(rand() * 2 ** 52)) + 2n ** 62n,
        );
        for (const minUsage of [0, 50, 79, 80, 100]) {
          const expected = getExistingStoreIndex(full, hashesBuffer(asked), minUsage);
          const actual = indexCacheQuery(cache, hashesBuffer(asked), minUsage);
          expect(actual.equals(expected), `query ${q}, min usage ${minUsage}`).toBe(true);
        }
      }

      // The serialized whole round-trips to the same answers.
      const rebuilt = indexCacheCreate();
      indexCacheAdd(rebuilt, indexCacheSerialize(cache));
      const asked = pool.slice(0, 50);
      expect(indexCacheQuery(rebuilt, hashesBuffer(asked), 80).equals(indexCacheQuery(cache, hashesBuffer(asked), 80))).toBe(true);
    });
  }

  it("answers an empty question and an unknown chunk with no blocks", () => {
    const cache = indexCacheCreate();
    indexCacheAdd(cache, writeStoreIndex({ hashIdentifier: HASH_ID, blocks: randomBlocks(rng(9), 10, [1n, 2n, 3n]) }));
    expect(readStoreIndex(indexCacheQuery(cache, hashesBuffer([]), 0)).blocks).toEqual([]);
    expect(readStoreIndex(indexCacheQuery(cache, hashesBuffer([999n]), 0)).blocks).toEqual([]);
  });

  it("drops a block under the usage threshold and keeps one at it", () => {
    const cache = indexCacheCreate();
    // One block: chunks of 80 and 20 bytes. Asking for the 80 is exactly 80%.
    indexCacheAdd(cache, writeStoreIndex({
      hashIdentifier: HASH_ID,
      blocks: [{ hash: 7n, tag: 0, chunks: [{ hash: 1n, size: 80 }, { hash: 2n, size: 20 }] }],
    }));
    expect(readStoreIndex(indexCacheQuery(cache, hashesBuffer([1n]), 80)).blocks).toHaveLength(1);
    expect(readStoreIndex(indexCacheQuery(cache, hashesBuffer([2n]), 80)).blocks).toHaveLength(0);
    expect(readStoreIndex(indexCacheQuery(cache, hashesBuffer([2n]), 0)).blocks).toHaveLength(1);
  });

  it("refuses an index hashed with a different algorithm", () => {
    const cache = indexCacheCreate();
    indexCacheAdd(cache, writeStoreIndex({ hashIdentifier: 1, blocks: [{ hash: 1n, tag: 0, chunks: [{ hash: 5n, size: 10 }] }] }));
    expect(() =>
      indexCacheAdd(cache, writeStoreIndex({ hashIdentifier: 2, blocks: [{ hash: 2n, tag: 0, chunks: [{ hash: 6n, size: 10 }] }] })),
    ).toThrow();
  });
});
