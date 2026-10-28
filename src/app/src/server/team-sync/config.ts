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
import { listStateTreeDir } from "~/server/state-tree";
import { mountCollisionErrors } from "./mounts";

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
 * (`teamsync.yaml` at the repo root) as resolved at `changelistNumber`.
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
    result = await rejectMountCollisions(
      db,
      repo.id,
      sourceChangelistNumber,
      result,
    );
  }

  cache.set(repo.id, { sourceChangelistNumber, result });
  return result;
}

/**
 * Invalidates a config whose nested links (`path`) are mounted onto files
 * this repo tracks at the config's changelist: the folder would belong to
 * both repos. Later submits can't add files there (see mountSubmitProblem).
 */
async function rejectMountCollisions(
  db: PrismaClient,
  repoId: string,
  changelistNumber: number,
  result: TeamSyncConfigResult,
): Promise<TeamSyncConfigResult> {
  const links = result.config?.linkedRepos;
  if (!links?.some((l) => l.path !== undefined)) return result;

  const changelist = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { stateRootHash: true },
  });
  const errors = await mountCollisionErrors(links, (dir) =>
    listStateTreeDir(db, repoId, changelist?.stateRootHash ?? null, dir),
  );
  if (errors.length === 0) return result;
  return { config: null, sourceChangelistNumber: changelistNumber, errors };
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
