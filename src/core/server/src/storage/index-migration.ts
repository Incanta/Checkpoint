// One-time migration of a repo to storage protocol 3: a block map for every
// version submitted before block maps existed.
//
// Pulls and file reads of such a version fall back to the repo-wide
// store.lsi, which is frozen since protocol 3 (nothing merges into it) but
// still lists every block those versions use. That works, at the cost of
// downloading store.lsi whole. Once every version has a block map, nothing
// reads store.lsi and it can be deleted.
//
// Each map is the existing-content answer for the version's chunks (whole
// blocks, any usage), then verified and stored exactly like a submitted one:
// a version whose chunks the index cannot cover is recorded as broken, not
// guessed at. Such a version was already unreadable.
//
// Runs in the background the first time a server loads a repo's index, under
// a lease so concurrent servers do not repeat it, and records its result in
// index/migration.json.

import { versionIndexChunkHashes } from "@checkpointvcs/longtail-addon";
import type { StorageBackend } from "./backend.js";

export interface MigrationDeps {
  backend: Pick<StorageBackend, "listKeys" | "getBuffer" | "put" | "putIfAbsent" | "delete">;
  repoId: string;
  basePath: string;
  /** The blocks holding `chunkHashes` (min usage 0), as a store index. */
  query(chunkHashes: Buffer): Buffer;
  /** Verifies and stores a block map; returns a problem, or null. */
  storeBlockMap(versionIndex: string, blockMap: Buffer): Promise<string | null>;
}

export interface MigrationResult {
  created: number;
  alreadyHad: number;
  broken: { versionIndex: string; problem: string }[];
}

/** Writes block maps for every version that lacks one. Idempotent. */
export async function migrateBlockMaps(deps: MigrationDeps): Promise<MigrationResult> {
  const { backend, basePath } = deps;
  const names = await backend.listKeys(`${basePath}/versions`);
  const maps = new Set(names.filter((n) => n.endsWith(".lsi")));
  const result: MigrationResult = { created: 0, alreadyHad: 0, broken: [] };

  for (const name of names) {
    if (!name.endsWith(".lvi") || name.includes("/")) continue;
    if (maps.has(name.replace(/\.lvi$/, ".lsi"))) {
      result.alreadyHad++;
      continue;
    }
    const versionIndex = await backend.getBuffer(`${basePath}/versions/${name}`);
    if (!versionIndex) continue;
    let problem: string | null;
    try {
      const blockMap = deps.query(versionIndexChunkHashes(versionIndex));
      problem = await deps.storeBlockMap(name, blockMap);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (problem) result.broken.push({ versionIndex: name, problem });
    else result.created++;
  }
  return result;
}

/**
 * Runs the migration for a repo unless it is done or another server is on
 * it. Never throws.
 */
export async function migrateRepoInBackground(deps: MigrationDeps): Promise<void> {
  const { backend, basePath } = deps;
  // Imported here so migrateBlockMaps stays usable without the server's
  // config (the logger loads it).
  const { Logger } = await import("../logging.js");
  const { withLease } = await import("./lease.js");
  try {
    await withLease(
      backend as StorageBackend,
      `${basePath}/index/migrate.lease`,
      async () => {
        if (await backend.getBuffer(`${basePath}/index/migration.json`)) return;
        const started = Date.now();
        const result = await migrateBlockMaps(deps);
        const record = Buffer.from(
          JSON.stringify({ complete: true, finishedAt: new Date().toISOString(), ...result }, null, 2),
        );
        await backend.put(`${basePath}/index/migration.json`, record, record.length);
        Logger.info(
          `[index-migrate] ${JSON.stringify({ basePath, created: result.created, alreadyHad: result.alreadyHad, broken: result.broken.length, ms: Date.now() - started })}`,
        );
        for (const b of result.broken) {
          Logger.warn(`[index-migrate] ${basePath}: no block map for ${b.versionIndex}: ${b.problem}`);
        }
      },
      // Another server holding it is doing the same work: skip, do not wait.
      { acquireTimeoutMs: 1 },
    );
  } catch (e) {
    Logger.info(`[index-migrate] ${basePath}: not run now (${(e as Error).message})`);
  }
}
