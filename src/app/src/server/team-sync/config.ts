import yaml from "js-yaml";
import type { PrismaClient } from "@prisma/client";

import {
  TeamSyncConfigSchema,
  TEAM_SYNC_CONFIG_PATH,
  type TeamSyncConfigResult,
} from "./config-schema";
import {
  findFileSourceChangelist,
  readFileAtChangelist,
} from "~/server/read-file-at-changelist";

interface CacheEntry {
  sourceChangelistNumber: number;
  result: TeamSyncConfigResult;
}

// Process-global cache keyed by repoId; an entry is valid while the config
// file's source changelist is unchanged (same pattern as the state-tree
// caches, survives Next dev hot reload via globalThis).
const CACHE_KEY = Symbol.for("checkpoint.teamSyncConfigCache");
const globalForCache = globalThis as unknown as {
  [CACHE_KEY]?: Map<string, CacheEntry>;
};
const cache = (globalForCache[CACHE_KEY] ??= new Map<string, CacheEntry>());

/**
 * Reads, validates, and caches the repo-committed Team Sync config
 * (`.checkpoint/teamsync.yaml`) as resolved at `changelistNumber`.
 */
export async function getTeamSyncConfig(
  db: PrismaClient,
  userId: string,
  repo: { id: string; orgId: string; r2BucketName: string | null },
  changelistNumber: number,
): Promise<TeamSyncConfigResult> {
  const sourceChangelistNumber = await findFileSourceChangelist(
    db,
    repo.id,
    TEAM_SYNC_CONFIG_PATH,
    changelistNumber,
  );

  if (sourceChangelistNumber === null) {
    return { config: null, sourceChangelistNumber: null, errors: null };
  }

  const cached = cache.get(repo.id);
  if (cached?.sourceChangelistNumber === sourceChangelistNumber) {
    return cached.result;
  }

  const file = await readFileAtChangelist(
    db,
    userId,
    repo,
    TEAM_SYNC_CONFIG_PATH,
    sourceChangelistNumber,
  );

  let result: TeamSyncConfigResult;

  if (file === null) {
    result = { config: null, sourceChangelistNumber: null, errors: null };
  } else {
    result = parseTeamSyncConfig(
      file.content.toString("utf-8"),
      sourceChangelistNumber,
    );
  }

  cache.set(repo.id, { sourceChangelistNumber, result });
  return result;
}

export function parseTeamSyncConfig(
  content: string,
  sourceChangelistNumber: number,
): TeamSyncConfigResult {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (err) {
    return {
      config: null,
      sourceChangelistNumber,
      errors: [
        `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const parsed = TeamSyncConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      config: null,
      sourceChangelistNumber,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    };
  }

  return {
    config: parsed.data,
    sourceChangelistNumber,
    errors: null,
  };
}
