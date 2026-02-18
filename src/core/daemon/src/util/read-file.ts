import config from "@incanta/config";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import {
  readFileFromVersionAsync,
  pollReadFileHandle,
  freeReadFileHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";

/** File extensions considered binary (not diffable as text). */
const BINARY_EXTENSIONS = new Set([
  ".uasset",
  ".umap",
  ".ubulk",
  ".utxt",
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tga",
  ".exr",
  ".hdr",
  ".dds",
  ".psd",
  ".tif",
  ".tiff",
  ".gif",
  ".ico",
  ".svg",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".fbx",
  ".obj",
  ".abc",
  ".gltf",
  ".glb",
  ".blend",
  ".3ds",
  ".bnk",
  ".wem",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".dll",
  ".so",
  ".dylib",
  ".exe",
  ".bin",
  ".dat",
  ".db",
  ".pdf",
]);

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export interface ReadFileWorkspace {
  daemonId: string;
  repoId: string;
  localPath?: string;
}

export interface ReadFileFromVersionOptions {
  workspace: ReadFileWorkspace;
  filePath: string; // Relative path within the version
  versionIndexName: string; // The version index name from the changelist record
  logLevel?: LongtailLogLevel;
}

export interface ReadFileFromChangelistOptions {
  workspace: ReadFileWorkspace;
  filePath: string; // Relative path within the version
  changelistNumber: number;
  logLevel?: LongtailLogLevel;
}

export interface ReadFileResult {
  cachePath: string;
  isBinary: boolean;
  size: number;
}

/**
 * Reads a single file from a historical version stored in Longtail
 * and writes it to the provided cachePath on disk.
 * Returns the cache path, binary flag, and size.
 */
export async function readFileFromVersion(
  options: ReadFileFromVersionOptions & { cachePath: string },
): Promise<ReadFileResult> {
  const {
    workspace,
    filePath,
    versionIndexName,
    cachePath,
    logLevel = config.get<LongtailLogLevel>("longtail.log-level"),
  } = options;

  const client = await CreateApiClientAuth(workspace.daemonId);

  // Get storage token (read-only)
  const storageTokenResponse = await client.storage.getToken.query({
    repoId: workspace.repoId,
    write: false,
  });

  if (
    !storageTokenResponse.token ||
    !storageTokenResponse.expiration ||
    !storageTokenResponse.backendUrl
  ) {
    throw new Error("Could not get storage token");
  }

  const token = storageTokenResponse.token;
  const tokenExpirationMs = storageTokenResponse.expiration * 1000;
  const backendUrl = storageTokenResponse.backendUrl;

  const filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) =>
    res.text(),
  );

  // Get the repo to construct the remote base path
  const repo = await client.repo.getRepo.query({ id: workspace.repoId });
  if (!repo) {
    throw new Error("Could not find repository");
  }

  const remoteBasePath = `/${repo.orgId}/${repo.id}`;

  console.log(
    `Reading file '${filePath.replace(/^[/\\]/, "")}' from version '${versionIndexName}'`,
  );

  const handle = readFileFromVersionAsync({
    filePath,
    versionIndexName,
    remoteBasePath,
    filerUrl,
    jwt: token,
    jwtExpirationMs: tokenExpirationMs,
    logLevel: GetLogLevel(logLevel),
  });

  if (!handle) {
    throw new Error("Failed to create async handle for reading file");
  }

  const { data, size } = await pollReadFileHandle(handle);

  freeReadFileHandle(handle);

  // Write the raw buffer to disk
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  if (data && size > 0) {
    await fs.writeFile(cachePath, data);
  } else {
    await fs.writeFile(cachePath, Buffer.alloc(0));
  }

  return {
    cachePath,
    isBinary: isBinaryFile(filePath),
    size: size ?? 0,
  };
}

/**
 * Reads a single file from a historical changelist and caches it on disk.
 * Returns the cache path, binary flag, and size.
 * This is a convenience wrapper that looks up the version index from the changelist.
 */
export async function readFileFromChangelist(
  options: ReadFileFromChangelistOptions,
): Promise<ReadFileResult> {
  const { workspace, filePath, changelistNumber, logLevel } = options;

  if (!workspace.localPath) {
    throw new Error(
      "workspace.localPath is required to cache file contents on disk",
    );
  }

  const cachePath = path.join(
    workspace.localPath,
    ".checkpoint",
    "cache",
    String(changelistNumber),
    filePath,
  );

  // Return cached file if it already exists
  if (existsSync(cachePath)) {
    const stat = await fs.stat(cachePath);
    return {
      cachePath,
      isBinary: isBinaryFile(filePath),
      size: stat.size,
    };
  }

  const client = await CreateApiClientAuth(workspace.daemonId);

  // Get the changelist to find the version index
  const changelist = await client.changelist.getChangelist.query({
    repoId: workspace.repoId,
    changelistNumber,
  });

  if (!changelist) {
    throw new Error(`Could not find changelist ${changelistNumber}`);
  }

  if (!changelist.versionIndex) {
    throw new Error(`Changelist ${changelistNumber} has no version index`);
  }

  return readFileFromVersion({
    workspace,
    filePath,
    versionIndexName: changelist.versionIndex,
    cachePath,
    logLevel,
  });
}
