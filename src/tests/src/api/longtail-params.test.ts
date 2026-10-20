/**
 * The Longtail format (chunk and block sizes, hashing, compression) is set
 * once for the instance and handed to clients with their storage token, so a
 * team's daemons never disagree. Each repo pins it on first use, so retuning
 * the instance never mixes chunk sizes within one repo's history (changelists
 * chunked differently cannot be pulled in one pass).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../harness/db";
import { makeOrg, makeRepo, makeUser, type TestUser } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { setConfig } from "../harness/config";
import {
  longtailParamsProblem,
  repoLongtailParams,
} from "~/server/longtail-params";

const VALID = {
  targetChunkSize: 32768,
  targetBlockSize: 8388608,
  maxChunksPerBlock: 1024,
  minBlockUsagePercent: 80,
  hashingAlgo: "blake3",
  compressionAlgo: "zstd",
};

describe("longtailParamsProblem", () => {
  it("accepts the defaults", () => {
    expect(longtailParamsProblem(VALID)).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "blake3"],
    ["a missing chunk size", { ...VALID, targetChunkSize: undefined }],
    ["a fractional chunk size", { ...VALID, targetChunkSize: 1.5 }],
    ["a zero chunk size", { ...VALID, targetChunkSize: 0 }],
    ["a negative block size", { ...VALID, targetBlockSize: -1 }],
    ["a chunk size given as text", { ...VALID, targetChunkSize: "32768" }],
    ["a huge chunk size", { ...VALID, targetChunkSize: 2 ** 31 }],
    ["block usage over 100%", { ...VALID, minBlockUsagePercent: 101 }],
    ["an unknown hash", { ...VALID, hashingAlgo: "sha1" }],
    ["a hash in the wrong case", { ...VALID, hashingAlgo: "BLAKE3" }],
    ["an unknown compression", { ...VALID, compressionAlgo: "gzip" }],
    ["no compression named", { ...VALID, compressionAlgo: "" }],
  ])("refuses %s", (_label, value) => {
    expect(longtailParamsProblem(value)).toEqual(expect.any(String));
  });

  it("accepts every compression and hash the addon knows", () => {
    for (const hashingAlgo of ["blake2", "blake3", "meow"]) {
      expect(longtailParamsProblem({ ...VALID, hashingAlgo })).toBeNull();
    }
    for (const compressionAlgo of ["none", "lz4", "zstd_max", "brotli_text"]) {
      expect(longtailParamsProblem({ ...VALID, compressionAlgo })).toBeNull();
    }
  });
});

describe("the repo's longtail format", () => {
  let testDb: TestDb;
  let db: TestDb["client"];
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.client;
    globalThis.__checkpointTestDb = db;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
    owner = await makeUser(db);
    orgId = (await makeOrg(db, { ownerId: owner.id, ownerRole: "ADMIN" })).id;
  });

  const tokenFor = async (repoId: string, write = false) =>
    (await makeAppCaller({ asUser: owner })).storage.getToken({
      repoId,
      write,
      clientProtocol: 3,
    });

  it("comes with the storage token, from the instance config", async () => {
    const repo = await makeRepo(db, orgId, owner.id);
    expect((await tokenFor(repo.id)).longtail).toEqual(VALID);
  });

  it("is pinned on first use, so retuning the instance changes new repos only", async () => {
    const existing = await makeRepo(db, orgId, owner.id);
    await tokenFor(existing.id, true);

    setConfig("longtail.target-chunk-size", 65536);
    setConfig("longtail.hashing-algo", "blake2");

    expect((await tokenFor(existing.id)).longtail).toEqual(VALID);
    const fresh = await makeRepo(db, orgId, owner.id);
    expect((await tokenFor(fresh.id)).longtail).toEqual({
      ...VALID,
      targetChunkSize: 65536,
      hashingAlgo: "blake2",
    });
  });

  it("is pinned by a read token too", async () => {
    const repo = await makeRepo(db, orgId, owner.id);
    await tokenFor(repo.id, false);
    const row = await db.repo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(JSON.parse(row.longtailParams!)).toEqual(VALID);
  });

  it("settles on one value when two first uses race", async () => {
    const repo = await db.repo.findUniqueOrThrow({
      where: { id: (await makeRepo(db, orgId, owner.id)).id },
    });
    // Each reads the instance config before its first await.
    const first = repoLongtailParams(db, repo);
    setConfig("longtail.target-chunk-size", 65536);
    const second = repoLongtailParams(db, repo);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    const row = await db.repo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(JSON.parse(row.longtailParams!)).toEqual(a);
  });

  it("refuses to hand out an unusable instance config, and pins nothing", async () => {
    const repo = await makeRepo(db, orgId, owner.id);
    setConfig("longtail.hashing-algo", "sha1");
    await expect(tokenFor(repo.id)).rejects.toThrow(/hashingAlgo/);
    const row = await db.repo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(row.longtailParams).toBeNull();
  });

  it("refuses a damaged pinned value instead of pinning a new one", async () => {
    const repo = await makeRepo(db, orgId, owner.id);
    await db.repo.update({
      where: { id: repo.id },
      data: { longtailParams: "{not json" },
    });
    await expect(tokenFor(repo.id)).rejects.toThrow(/pinned longtail/);
    const row = await db.repo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(row.longtailParams).toBe("{not json");
  });
});
