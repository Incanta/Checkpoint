// Server-side access to per-version block maps (versions/<name>.lsi): the
// storage descriptor native code needs to reach the backend directly, and the
// verify-then-store step every block map goes through.

import config from "@incanta/config";
import {
  storeBlockMapAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import { getR2Endpoint } from "../utils/r2.js";

// The backend storage descriptor native server-side code needs, from the configured storage.mode. "local" merges against local disk;
// "s3" covers both s3 mode (shared bucket) and r2 mode (per-repo bucket), both
// via the addon's S3 adapter with the server's full credentials.
export async function buildServerStorageOptions(
  repoId: string,
): Promise<Record<string, unknown>> {
  const mode = config.get<string>("storage.mode");
  if (mode === "local") {
    return {
      storageType: "local",
      localStoragePath: config.get<string>("storage.local.path"),
    };
  }
  if (mode === "s3") {
    return {
      storageType: "s3",
      s3Endpoint: config.get<string>("storage.s3.endpoint"),
      s3Region: config.get<string>("storage.s3.region"),
      s3Bucket: config.get<string>("storage.s3.bucket"),
      s3ForcePathStyle: config.get<boolean>("storage.s3.force-path-style"),
      s3AccessKeyId: await config.getWithSecrets<string>(
        "storage.s3.access-key-id",
      ),
      s3SecretAccessKey: await config.getWithSecrets<string>(
        "storage.s3.secret-access-key",
      ),
    };
  }
  // r2: the addon's S3 adapter pointed at R2, per-repo bucket.
  return {
    storageType: "s3",
    s3Endpoint: getR2Endpoint(),
    s3Region: "auto",
    s3Bucket: `checkpoint-${repoId}`,
    s3ForcePathStyle: false,
    s3AccessKeyId: await config.getWithSecrets<string>(
      "storage.r2.access-key-id",
    ),
    s3SecretAccessKey: await config.getWithSecrets<string>(
      "storage.r2.secret-access-key",
    ),
  };
}

/**
 * Verifies and stores a submit's block map beside its version index (see
 * block-map.cpp). Returns a message describing the problem, or null.
 */
export async function storeBlockMap(
  repoId: string,
  basePath: string,
  versionIndex: string,
  blockMapBuffer: Buffer,
): Promise<string | null> {
  const handle = storeBlockMapAsync({
    remoteBasePath: basePath,
    versionIndex,
    blockMapBuffer,
    logLevel: GetLogLevel(config.get<LongtailLogLevel>("longtail.log-level")),
    ...(await buildServerStorageOptions(repoId)),
  } as Parameters<typeof storeBlockMapAsync>[0]);
  if (!handle) {
    return "Failed to create longtail handle for the block map";
  }
  try {
    const { status } = await pollHandle(handle);
    return status.error === 0
      ? null
      : `Block map for ${versionIndex} refused: ${status.currentStep} (error ${status.error})`;
  } finally {
    freeHandle(handle);
  }
}

