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

export interface FileAtChangelist {
  content: Buffer;
  /** The changelist that last touched the file at or before the requested CL. */
  sourceChangelistNumber: number;
}

/**
 * Reads a file's content as it existed at `changelistNumber` (the latest
 * FileChange at or before it), without a workspace. Returns null when the
 * file does not exist at that changelist (never changed, or deleted).
 *
 * Extracted from file.readFileContent so config readers (Game Sync) share
 * the same resolve-then-longtail-read path.
 */
export async function readFileAtChangelist(
  db: PrismaClient,
  userId: string,
  repo: { id: string; orgId: string; r2BucketName: string | null },
  filePath: string,
  changelistNumber: number,
): Promise<FileAtChangelist | null> {
  const fileChange = await db.fileChange.findFirst({
    where: {
      repoId: repo.id,
      changelistNumber: {
        lte: changelistNumber,
      },
      file: {
        path: filePath,
      },
    },
    orderBy: {
      changelistNumber: "desc",
    },
    include: {
      changelist: true,
    },
  });

  if (
    !fileChange ||
    fileChange.type === FileChangeType.DELETE ||
    !fileChange.changelist?.versionIndex
  ) {
    return null;
  }

  const remoteBasePath = `/${repo.orgId}/${repo.id}`;
  const storageOptions = await buildAddonStorageOptions(userId, repo, false);
  const logLevel = GetLogLevel(
    config.get<string>("logging.longtail-level") as LongtailLogLevel,
  );

  const handle = readFileFromVersionAsync({
    filePath,
    versionIndexName: fileChange.changelist.versionIndex,
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
      sourceChangelistNumber: fileChange.changelistNumber,
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
  const fileChange = await db.fileChange.findFirst({
    where: {
      repoId,
      changelistNumber: {
        lte: changelistNumber,
      },
      file: {
        path: filePath,
      },
    },
    orderBy: {
      changelistNumber: "desc",
    },
    select: {
      changelistNumber: true,
      type: true,
    },
  });

  if (!fileChange || fileChange.type === FileChangeType.DELETE) {
    return null;
  }

  return fileChange.changelistNumber;
}
