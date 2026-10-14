/**
 * Migrating a repo to block maps: every version submitted before block maps
 * existed gets one, built from the dedup index and verified like a submitted
 * map, after which reads of that version no longer need store.lsi.
 *
 * Runs migrateBlockMaps in-process against the dev server's local storage
 * (local mode only): a submitted version's block map is deleted from disk to
 * stand in for one from before block maps.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  freeHandle,
  indexCacheAdd,
  indexCacheCreate,
  indexCacheQuery,
  pollHandle,
  storeBlockMapAsync,
} from "@checkpointvcs/longtail-addon";

import { migrateBlockMaps } from "../../../core/server/src/storage/index-migration.js";
import {
  createContext,
  createWorkspace,
  enabled,
  nativeSubmit,
  readCommitted,
  versionIndexOf,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

const STORAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../core/server/data/storage",
);
const run = enabled && existsSync(STORAGE_ROOT);

describe.skipIf(!run)("block map migration", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace;
  const repoDir = () => path.join(STORAGE_ROOT, ctx.orgId, ctx.repoId);
  const basePath = () => `/${ctx.orgId}/${ctx.repoId}`;

  beforeAll(async () => {
    ctx = await createContext("index-migration");
    ws = await createWorkspace(ctx, "index-migration");
  });

  afterAll(async () => {
    await ws?.cleanup();
  });

  /** A minimal local backend over the server's storage directory. */
  const backend = {
    async listKeys(prefix: string) {
      const root = path.join(STORAGE_ROOT, prefix);
      const out: string[] = [];
      const walk = async (dir: string, rel: string) => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const name = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(dir, e.name), name);
          else out.push(name);
        }
      };
      await walk(root, "");
      return out;
    },
    async getBuffer(key: string) {
      try {
        return await readFile(path.join(STORAGE_ROOT, key));
      } catch {
        return null;
      }
    },
    async put(key: string, body: Buffer) {
      await mkdir(path.dirname(path.join(STORAGE_ROOT, key)), { recursive: true });
      await writeFile(path.join(STORAGE_ROOT, key), body);
    },
    async putIfAbsent(key: string, body: Buffer) {
      if (existsSync(path.join(STORAGE_ROOT, key))) return false;
      await this.put(key, body);
      return true;
    },
    async delete(key: string) {
      await rm(path.join(STORAGE_ROOT, key), { force: true });
    },
  };

  async function indexFromSegments() {
    const cache = indexCacheCreate();
    for (const key of await backend.listKeys(`${basePath()}/index/seg`)) {
      indexCacheAdd(cache, (await backend.getBuffer(`${basePath()}/index/seg/${key}`))!);
    }
    return cache;
  }

  async function storeMap(versionIndex: string, blockMap: Buffer) {
    const handle = storeBlockMapAsync({
      remoteBasePath: basePath(),
      versionIndex,
      blockMapBuffer: blockMap,
      storageType: "local",
      localStoragePath: STORAGE_ROOT,
      logLevel: 4,
    } as Parameters<typeof storeBlockMapAsync>[0]);
    try {
      const { status } = await pollHandle(handle);
      return status.error === 0 ? null : status.currentStep;
    } finally {
      freeHandle(handle);
    }
  }

  it("rebuilds a missing block map that makes the version readable without store.lsi", async () => {
    const content = randomBytes(2 * 1024 * 1024);
    await write(ws, "old/legacy.bin", content);
    const submitted = await nativeSubmit(ctx, ws, [{ path: "old/legacy.bin", delete: false }]);
    expect(submitted.error, submitted.step).toBe(0);

    const versionIndex = await versionIndexOf(ctx, submitted.changelistNumber!);
    // Only meaningful when the server stores on local disk (CI also runs s3).
    if (!existsSync(path.join(repoDir(), "versions"))) return;
    const mapFile = path.join(repoDir(), "versions", versionIndex.replace(/\.lvi$/, ".lsi"));
    expect(existsSync(mapFile)).toBe(true);
    // Stand-in for a version from before block maps.
    await rename(mapFile, `${mapFile}.removed`);

    const cache = await indexFromSegments();
    const result = await migrateBlockMaps({
      backend: backend as never,
      repoId: ctx.repoId,
      basePath: basePath(),
      query: (hashes) => indexCacheQuery(cache, hashes, 0),
      storeBlockMap: storeMap,
    });

    expect(result.broken).toEqual([]);
    expect(result.created).toBe(1);
    expect(existsSync(mapFile)).toBe(true);

    // This repo never had a store.lsi, so the read can only succeed through
    // the rebuilt map.
    expect(existsSync(path.join(repoDir(), "store.lsi"))).toBe(false);
    const read = await readCommitted(ctx, submitted.changelistNumber!, "old/legacy.bin");
    expect(read.equals(content)).toBe(true);

    // A second run finds nothing to do.
    const again = await migrateBlockMaps({
      backend: backend as never,
      repoId: ctx.repoId,
      basePath: basePath(),
      query: (hashes) => indexCacheQuery(cache, hashes, 0),
      storeBlockMap: storeMap,
    });
    expect(again.created).toBe(0);
  });

  it("records a version the index cannot cover as broken rather than guessing", async () => {
    await write(ws, "old/orphan.bin", randomBytes(512 * 1024));
    const submitted = await nativeSubmit(ctx, ws, [{ path: "old/orphan.bin", delete: false }]);
    expect(submitted.error, submitted.step).toBe(0);
    const versionIndex = await versionIndexOf(ctx, submitted.changelistNumber!);
    if (!existsSync(path.join(repoDir(), "versions"))) return;
    await rm(path.join(repoDir(), "versions", versionIndex.replace(/\.lvi$/, ".lsi")));

    const result = await migrateBlockMaps({
      backend: backend as never,
      repoId: ctx.repoId,
      basePath: basePath(),
      // An index that knows no blocks at all.
      query: () => indexCacheQuery(indexCacheCreate(), Buffer.alloc(0), 0),
      storeBlockMap: storeMap,
    });
    expect(result.broken.map((b) => b.versionIndex)).toContain(versionIndex);
  });
});
