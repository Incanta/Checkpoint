// R1 block-size benchmark on real project data. Gated behind BENCH=1 so it
// doesn't run in the normal suite. Reads a path manifest produced by scan.ts and
// reports, per candidate block budget: block count, total stored bytes, block
// size distribution, build time, and the churn (new blocks) for a single-file
// edit and a whole-region edit. Used to choose the budget before freezing.
//
//   BENCH=1 MANIFEST=E:/work/checkpoint/Checkpoint/.tmp-titan-content.json \
//     npx vitest run src/tree/bench.test.ts

import { describe, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { buildTree, MemBlockStore, type StateMap } from "~/server/tree/tree";

const MANIFEST =
  process.env.MANIFEST ?? "E:/work/checkpoint/Checkpoint/.tmp-titan-content.json";
const BUDGETS = [32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024];

function hashCl(path: string): number {
  // Vary source CLs so identical sibling subtrees don't all dedup (a
  // conservative estimate; real low-churn repos dedup even better).
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1_000_000;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

describe("tree block-size benchmark", () => {
  it.skipIf(!process.env.BENCH)(
    "reports block stats and churn per budget",
    async () => {
      if (!existsSync(MANIFEST)) throw new Error(`manifest not found: ${MANIFEST}`);
      const paths: string[] = JSON.parse(readFileSync(MANIFEST, "utf8"));
      console.log(`\nmanifest: ${MANIFEST}  (${paths.length} files)`);

      const base: StateMap = new Map();
      for (const p of paths) base.set(p, hashCl(p));

      // Pick a single deep file and a region (its 5-segment ancestor) to edit.
      const deep = [...base.keys()].sort((a, b) => b.length - a.length)[0]!;
      const regionPrefix = deep.split("/").slice(0, 5).join("/") + "/";
      const regionFiles = [...base.keys()].filter((p) => p.startsWith(regionPrefix));
      console.log(`single edit:  ${deep}`);
      console.log(`region edit:  ${regionPrefix}  (${regionFiles.length} files)`);

      for (const budget of BUDGETS) {
        const store = new MemBlockStore();
        const t0 = Date.now();
        const root = await buildTree(base.entries(), store, budget);
        const buildMs = Date.now() - t0;
        const sizes = store.blockSizes().sort((a, b) => a - b);

        // Single-file edit churn (same store, idempotent puts).
        const single = new Map(base);
        single.set(deep, 999_999);
        let beforeB = store.newBlocks;
        let beforeBytes = store.newBytes;
        await buildTree(single.entries(), store, budget);
        const singleChurn = store.newBlocks - beforeB;
        const singleBytes = store.newBytes - beforeBytes;

        // Region edit churn.
        const region = new Map(base);
        for (const p of regionFiles) region.set(p, 888_888);
        beforeB = store.newBlocks;
        beforeBytes = store.newBytes;
        await buildTree(region.entries(), store, budget);
        const regionChurn = store.newBlocks - beforeB;
        const regionBytes = store.newBytes - beforeBytes;

        console.log(`\n── budget ${(budget / 1024).toFixed(0)} KB ──`);
        console.log(`  root            ${root.slice(0, 12)}…`);
        console.log(`  blocks          ${store.size}`);
        console.log(`  stored bytes    ${(store.totalBytes / 1e6).toFixed(1)} MB`);
        console.log(`  block size      p50=${pct(sizes, 50)}  p99=${pct(sizes, 99)}  max=${sizes[sizes.length - 1]}`);
        console.log(`  build           ${buildMs} ms`);
        console.log(`  single-edit churn  ${singleChurn} blocks, ${(singleBytes / 1024).toFixed(1)} KB written`);
        console.log(`  region-edit churn  ${regionChurn} blocks, ${(regionBytes / 1024).toFixed(1)} KB written`);
      }
    },
    600_000,
  );
});
