import config from "@incanta/config";
import { ptr, toArrayBuffer } from "bun:ffi";
import { existsSync, promises as fs } from "fs";
import path from "path";
import {
  CreateLongtailLibrary,
  createStringBuffer,
  decodeReadFileHandle,
  GetLogLevel,
  type LongtailLogLevel,
  CreateApiClientAuth,
} from "@checkpointvcs/common";

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

export interface ReadFileFromVersionResult {
  content: string;
  size: number;
}

/**
 * Reads a single file from a historical version stored in Longtail.
 * This allows retrieving the content of a file at a specific changelist
 * without downloading the entire version.
 */
export async function readFileFromVersion(
  options: ReadFileFromVersionOptions,
): Promise<ReadFileFromVersionResult> {
  const {
    workspace,
    filePath,
    versionIndexName,
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

  // Create buffers for FFI calls
  const filePathBuffer = createStringBuffer(filePath);
  const versionIndexBuffer = createStringBuffer(versionIndexName);
  const remoteBasePathBuffer = createStringBuffer(remoteBasePath);
  const filerUrlBuffer = createStringBuffer(filerUrl);
  const tokenBuffer = createStringBuffer(token);

  // Load the Longtail library
  const lib = CreateLongtailLibrary();

  // Call the async function
  const asyncHandle = lib.ReadFileFromVersionAsync(
    ptr(filePathBuffer),
    ptr(versionIndexBuffer),
    ptr(remoteBasePathBuffer),
    ptr(filerUrlBuffer),
    ptr(tokenBuffer),
    BigInt(tokenExpirationMs),
    GetLogLevel(logLevel),
  );

  if (!asyncHandle) {
    throw new Error("Failed to create async handle for reading file");
  }

  // Wait for completion
  // The handle size is: WrapperAsyncHandle (2320) + data ptr (8) + size (8) = 2336 bytes
  const handleSize = 2336;
  let lastStep = "";

  while (true) {
    const handleData = new Uint8Array(
      toArrayBuffer(asyncHandle, 0, handleSize),
    );
    const decoded = decodeReadFileHandle(handleData);

    if (decoded.currentStep !== lastStep) {
      lastStep = decoded.currentStep;
    }

    if (decoded.completed) {
      if (decoded.error !== 0) {
        lib.FreeReadFileHandle(asyncHandle);
        throw new Error(
          `Failed to read file: ${lastStep.replace(/\\0/g, "")} (error: ${decoded.error})`,
        );
      }

      // Get the file data
      const dataPtr = lib.GetReadFileData(asyncHandle);
      const size = lib.GetReadFileSize(asyncHandle);

      let content = "";
      if (dataPtr && size > 0n) {
        const dataBuffer = new Uint8Array(
          toArrayBuffer(dataPtr, 0, Number(size)),
        );
        content = Buffer.from(dataBuffer).toString("utf-8");
      }

      // Free the handle (which also frees the data)
      lib.FreeReadFileHandle(asyncHandle);

      // Keep references to prevent GC during FFI calls
      // eslint-disable-next-line no-constant-condition
      if (false) {
        console.log(
          filePathBuffer,
          versionIndexBuffer,
          remoteBasePathBuffer,
          filerUrlBuffer,
          tokenBuffer,
        );
      }

      return {
        content,
        size: Number(size),
      };
    }

    // Small delay to avoid busy-waiting
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Reads a single file from a historical changelist.
 * This is a convenience wrapper that looks up the version index from the changelist.
 */
export async function readFileFromChangelist(
  options: ReadFileFromChangelistOptions,
): Promise<ReadFileFromVersionResult> {
  const { workspace, filePath, changelistNumber, logLevel } = options;

  // Check cache if workspace.localPath is provided
  if (workspace.localPath) {
    const cachePath = path.join(
      workspace.localPath,
      ".checkpoint",
      "cache",
      String(changelistNumber),
      filePath,
    );

    if (existsSync(cachePath)) {
      const content = await fs.readFile(cachePath, "utf-8");
      return {
        content,
        size: Buffer.byteLength(content, "utf-8"),
      };
    }
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

  const result = await readFileFromVersion({
    workspace,
    filePath,
    versionIndexName: changelist.versionIndex,
    logLevel,
  });

  // Write to cache if workspace.localPath is provided
  if (workspace.localPath) {
    const cachePath = path.join(
      workspace.localPath,
      ".checkpoint",
      "cache",
      String(changelistNumber),
      filePath,
    );

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, result.content, "utf-8");
  }

  return result;
}
