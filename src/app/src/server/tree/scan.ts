// R1 recon: walk a real project directory and report the shape that drives the
// tree design (file/folder counts, max directory fan-out, depth distribution),
// and emit a path manifest for reuse by the block-size benchmark.
//
// Run with Node's built-in TS support (no build step):
//   node src/app/src/server/tree/scan.ts <root> <outManifest.json> [exclude,exclude,...]
//
// Excludes are matched against top-level and any path segment.

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2]!;
const out = process.argv[3]!;
const excludes = new Set(
  (process.argv[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

if (!root || !out) {
  console.error("usage: node scan.ts <root> <outManifest.json> [excl,...]");
  process.exit(1);
}

let files = 0;
let dirs = 0;
let maxFanout = 0;
let maxFanoutDir = "";
const depthHist = new Map<number, number>();
const fanoutBuckets = new Map<string, number>(); // bucket label -> count of dirs
const topDirs: { dir: string; count: number }[] = [];
const paths: string[] = [];

function bucket(n: number): string {
  if (n <= 1) return "1";
  if (n <= 4) return "2-4";
  if (n <= 16) return "5-16";
  if (n <= 64) return "17-64";
  if (n <= 256) return "65-256";
  if (n <= 1024) return "257-1024";
  if (n <= 4096) return "1025-4096";
  return "4097+";
}

function walk(dir: string, depth: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  let childCount = 0;
  for (const name of entries) {
    if (excludes.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    childCount++;
    if (st.isDirectory()) {
      dirs++;
      depthHist.set(depth, (depthHist.get(depth) ?? 0) + 1);
      walk(full, depth + 1);
    } else {
      files++;
      paths.push(relative(root, full).split(sep).join("/"));
    }
  }
  const fb = bucket(childCount);
  fanoutBuckets.set(fb, (fanoutBuckets.get(fb) ?? 0) + 1);
  if (childCount > maxFanout) {
    maxFanout = childCount;
    maxFanoutDir = dir;
  }
  topDirs.push({ dir, count: childCount });
}

const t0 = Date.now();
walk(root, 0);
const ms = Date.now() - t0;

writeFileSync(out, JSON.stringify(paths));

console.log(`root: ${root}`);
console.log(`scanned in ${ms} ms`);
console.log(`files: ${files}`);
console.log(`dirs:  ${dirs}`);
console.log(`max fan-out: ${maxFanout}  (${maxFanoutDir})`);
console.log(`avg path len: ${Math.round(paths.reduce((a, p) => a + p.length, 0) / Math.max(1, paths.length))} chars`);
console.log("fan-out distribution (dirs by child count):");
for (const label of ["1", "2-4", "5-16", "17-64", "65-256", "257-1024", "1025-4096", "4097+"]) {
  if (fanoutBuckets.has(label)) console.log(`  ${label.padStart(10)}: ${fanoutBuckets.get(label)}`);
}
const depths = [...depthHist.keys()].sort((a, b) => a - b);
console.log(`depth range: ${depths[0]}..${depths[depths.length - 1]}`);
console.log("top directories by fan-out:");
topDirs.sort((a, b) => b.count - a.count);
for (const t of topDirs.slice(0, 12)) console.log(`  ${String(t.count).padStart(7)}  ${t.dir}`);
console.log(`manifest written: ${out} (${paths.length} paths)`);
