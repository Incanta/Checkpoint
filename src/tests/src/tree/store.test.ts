// R2 foundation: the Prisma-backed BlockStore round-trips a state tree through
// the database (build -> TreeBlock rows -> materialize), and is idempotent.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeUser, makeOrg, makeRepo } from "../harness/fixtures";
import {
  buildStateTreeBlocks,
  materializeStateTreeBlocks,
  diffStateTrees,
} from "~/server/state-tree";

describe("Prisma-backed tree block store (R2)", () => {
  let testDb: TestDb;

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
  });

  async function repoId(): Promise<string> {
    const owner = await makeUser(testDb.client);
    const org = await makeOrg(testDb.client, { ownerId: owner.id, ownerRole: "ADMIN" });
    const repo = await makeRepo(testDb.client, org.id, owner.id);
    return repo.id;
  }

  it("builds to the DB and materializes back", async () => {
    const db = testDb.client;
    const id = await repoId();
    const state = new Map<string, number>([
      ["Content/__ExternalActors__/Maps/M/A/0/a.uasset", 7],
      ["Content/__ExternalActors__/Maps/M/A/0/b.uasset", 7],
      ["Content/__ExternalActors__/Maps/M/B/1/c.uasset", 3],
      ["Source/Game/Game.cpp", 5],
    ]);

    const root = await buildStateTreeBlocks(db, id, state.entries());
    const blocks = await db.treeBlock.count({ where: { repoId: id } });
    expect(blocks).toBeGreaterThan(0);

    const got = await materializeStateTreeBlocks(db, id, root);
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(state));
  });

  it("is idempotent: rebuilding the same state writes no new blocks", async () => {
    const db = testDb.client;
    const id = await repoId();
    const state = new Map<string, number>([
      ["a/b/c.uasset", 1],
      ["a/b/d.uasset", 2],
      ["e/f.uasset", 3],
    ]);

    const r1 = await buildStateTreeBlocks(db, id, state.entries());
    const after1 = await db.treeBlock.count({ where: { repoId: id } });
    const r2 = await buildStateTreeBlocks(db, id, state.entries());
    const after2 = await db.treeBlock.count({ where: { repoId: id } });

    expect(r2).toBe(r1);
    expect(after2).toBe(after1);
  });

  it("diffStateTrees returns path-keyed changes and the CLs to pull", async () => {
    const db = testDb.client;
    const id = await repoId();

    const r1 = await buildStateTreeBlocks(
      db,
      id,
      new Map([
        ["dir/a.txt", 1],
        ["dir/b.txt", 1],
        ["dir/old.txt", 1],
      ]).entries(),
    );
    await db.changelist.create({
      data: { repoId: id, number: 1, message: "", versionIndex: "", stateRootHash: r1 },
    });

    // CL 2: modify a (now from CL 2), keep b, add c (CL 2), remove old.
    const r2 = await buildStateTreeBlocks(
      db,
      id,
      new Map([
        ["dir/a.txt", 2],
        ["dir/b.txt", 1],
        ["dir/c.txt", 2],
      ]).entries(),
    );
    await db.changelist.create({
      data: { repoId: id, number: 2, message: "", versionIndex: "", stateRootHash: r2 },
    });

    const d = await diffStateTrees(db, id, 1, 2);
    expect(d.added.map((c) => c.path)).toEqual(["dir/c.txt"]);
    expect(d.added[0]!.cl).toBe(2);
    expect(d.modified.map((c) => c.path)).toEqual(["dir/a.txt"]);
    expect(d.modified[0]!.cl).toBe(2);
    expect(d.removed).toEqual(["dir/old.txt"]);
    expect(d.changelistsToPull).toEqual([2]);
  });

  it("blocks are scoped per repo", async () => {
    const db = testDb.client;
    const a = await repoId();
    const b = await repoId();
    const state = new Map<string, number>([["x/y.uasset", 1]]);

    const ra = await buildStateTreeBlocks(db, a, state.entries());
    await buildStateTreeBlocks(db, b, state.entries());

    // Same content -> same hash, but stored independently under each repo.
    const inA = await db.treeBlock.count({ where: { repoId: a } });
    const inB = await db.treeBlock.count({ where: { repoId: b } });
    expect(inA).toBeGreaterThan(0);
    expect(inB).toBe(inA);
    // Materializing from repo a's store works.
    expect(
      Object.fromEntries(await materializeStateTreeBlocks(db, a, ra)),
    ).toEqual(Object.fromEntries(state));
  });
});
