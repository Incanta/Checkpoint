import config from "@incanta/config";
import {
  readFileFromVersionAsync,
  pollReadFileHandle,
  freeReadFileHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import { FileChangeType, type PrismaClient } from "@prisma/client";

import { buildAddonStorageOptions } from "~/server/storage-options";
import { lookupStateTreePaths } from "~/server/state-tree";

export interface FileSource {
  /** The changelist that wrote the file's content as of the requested one. */
  sourceChangelistNumber: number;
  /** That changelist's version index, which is where the content lives. */
  versionIndex: string;
}

/**
 * Finds which changelist holds `filePath`'s content as of `changelistNumber`.
 * Returns null when the file does not exist there.
 *
 * The answer comes from the changelist's state tree, which maps each path to
 * the changelist that last wrote it along that changelist's own history.
 *
 * It used to come from "the newest FileChange for this path numbered at or
 * below the requested changelist". Numbers are shared by every branch in the
 * repo, so that picked up changes from branches the requested changelist does
 * not descend from, and served their content as if it were its own. It also
 * landed on merge changelists, which record a FileChange for each path they
 * carry but upload nothing themselves.
 *
 * Changelists from before state trees have no tree to ask; for those the old
 * lookup is all there is.
 */
export async function resolveFileSource(
  db: PrismaClient,
  repoId: string,
  filePath: string,
  changelistNumber: number,
): Promise<FileSource | null> {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "");

  const changelist = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { stateRootHash: true },
  });

  if (changelist?.stateRootHash) {
    // One path: read only the blocks on the way to it.
    const tree = await lookupStateTreePaths(
      db,
      repoId,
      changelist.stateRootHash,
      [normalized],
    );
    const sourceNumber = tree.get(normalized);
    if (sourceNumber === undefined) {
      return null;
    }
    const source = await db.changelist.findUnique({
      where: { repoId_number: { repoId, number: sourceNumber } },
      select: { versionIndex: true },
    });
    if (!source?.versionIndex) {
      return null;
    }
    return {
      sourceChangelistNumber: sourceNumber,
      versionIndex: source.versionIndex,
    };
  }

  const fileChange = await db.fileChange.findFirst({
    where: {
      repoId,
      changelistNumber: { lte: changelistNumber },
      file: { path: normalized },
    },
    orderBy: { changelistNumber: "desc" },
    include: { changelist: { select: { versionIndex: true } } },
  });
  if (
    !fileChange ||
    fileChange.type === FileChangeType.DELETE ||
    !fileChange.changelist?.versionIndex
  ) {
    return null;
  }
  return {
    sourceChangelistNumber: fileChange.changelistNumber,
    versionIndex: fileChange.changelist.versionIndex,
  };
}

export interface FileAtChangelist {
  content: Buffer;
  /** The changelist that wrote the content the requested changelist sees. */
  sourceChangelistNumber: number;
}

/**
 * Reads a file's content as it existed at `changelistNumber`, without a
 * workspace. Returns null when the file does not exist at that changelist
 * (never added, or deleted). See resolveFileSource for how "as it existed" is
 * decided.
 *
 * Extracted from file.readFileContent so config readers (Team Sync) share
 * the same resolve-then-longtail-read path.
 */
export async function readFileAtChangelist(
  db: PrismaClient,
  userId: string,
  repo: { id: string; orgId: string; r2BucketName: string | null },
  filePath: string,
  changelistNumber: number,
): Promise<FileAtChangelist | null> {
  const source = await resolveFileSource(
    db,
    repo.id,
    filePath,
    changelistNumber,
  );
  if (!source) {
    return null;
  }

  const remoteBasePath = `/${repo.orgId}/${repo.id}`;
  const storageOptions = await buildAddonStorageOptions(userId, repo, false);
  const logLevel = GetLogLevel(
    config.get<string>("logging.longtail-level") as LongtailLogLevel,
  );

  const handle = readFileFromVersionAsync({
    filePath,
    versionIndexName: source.versionIndex,
    remoteBasePath,
    ...storageOptions,
    logLevel,
  });

  if (!handle) {
    throw new Error(`Failed to initiate file read for ${filePath}`);
  }

  try {
    const { data, size } = await pollReadFileHandle(handle);
    return {
      content: data && size > 0 ? data : Buffer.alloc(0),
      sourceChangelistNumber: source.sourceChangelistNumber,
    };
  } finally {
    freeReadFileHandle(handle);
  }
}

/**
 * Resolves which changelist last touched `filePath` at or before
 * `changelistNumber` without reading content. Returns null when absent or
 * deleted. Cheap (one indexed FileChange lookup): use as a cache key before
 * paying for a content read.
 */
export async function findFileSourceChangelist(
  db: PrismaClient,
  repoId: string,
  filePath: string,
  changelistNumber: number,
): Promise<number | null> {
  const source = await resolveFileSource(
    db,
    repoId,
    filePath,
    changelistNumber,
  );
  return source?.sourceChangelistNumber ?? null;
}
