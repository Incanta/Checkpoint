// The sparse three-way merge reads only the paths the incoming side changed.
// It must agree exactly with mergeTrees, which compares the full maps, and
// the tree it produces must be the one a full build of the merged map gives.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeOrg, makeRepo, makeUser } from "../harness/fixtures";
import {
  applyStateTreeChanges,
  buildStateTreeBlocks,
} from "~/server/state-tree";
import { mergeStateTreesSparse, mergeTrees } from "~/server/branch-merge";

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

const PATHS = Array.from(
  { length: 120 },
  (_, i) => `dir${i % 6}/sub${i % 4}/file${i}.txt`,
);

/** A variation of `from`: some paths changed, some removed, some added. */
function vary(from: Map<string, number>, rand: () => number, cl: number) {
  const next = new Map(from);
  for (const p of PATHS) {
    const r = rand();
    if (r < 0.08) next.delete(p);
    else if (r < 0.2) next.set(p, cl + Math.floor(rand() * 3));
  }
  return next;
}

describe("mergeStateTreesSparse", () => {
  let testDb: TestDb;
  let repoId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    globalThis.__checkpointTestDb = testDb.client;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
    const owner = await makeUser(testDb.client);
    const org = await makeOrg(testDb.client, { ownerId: owner.id, ownerRole: "ADMIN" });
    repoId = (await makeRepo(testDb.client, org.id, owner.id)).id;
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("agrees with mergeTrees (seed %i)", async (seed) => {
    const rand = rng(seed);
    const db = testDb.client;
    const base = new Map(PATHS.filter(() => rand() < 0.7).map((p) => [p, 1] as [string, number]));
    const target = vary(base, rand, 10);
    // Sometimes the target has not moved at all.
    const targetMap = seed % 4 === 0 ? base : target;
    const incoming = vary(base, rand, 20);

    const [baseRoot, targetRoot, incomingRoot] = await Promise.all([
      buildStateTreeBlocks(db, repoId, base.entries()),
      buildStateTreeBlocks(db, repoId, targetMap.entries()),
      buildStateTreeBlocks(db, repoId, incoming.entries()),
    ]);

    const full = mergeTrees(base, targetMap, incoming);
    const sparse = await mergeStateTreesSparse(db, repoId, baseRoot, targetRoot, incomingRoot);

    expect(sparse.applied).toEqual(full.applied);
    expect(sparse.conflicts).toEqual(full.conflicts);

    if (full.conflicts.length === 0) {
      const merged = await applyStateTreeChanges(
        db,
        repoId,
        targetRoot,
        sparse.applied.map((c) =>
          c.incoming === null
            ? { path: c.path, delete: true as const }
            : { path: c.path, cl: c.incoming },
        ),
      );
      expect(merged).toBe(await buildStateTreeBlocks(db, repoId, full.merged.entries()));
      if (targetRoot === baseRoot) expect(merged).toBe(incomingRoot);
    }
  });
});
