import config from "@incanta/config";
import njwt from "njwt";
import type { StorageOptions } from "@checkpointvcs/longtail-addon";
import {
  isR2Enabled,
  getR2Endpoint,
  createR2TempCredentials,
} from "~/server/r2-service";

/**
 * Build the addon storage options for a server-side (app) read/write of a repo's
 * content. Mirrors storage.getToken but returns the addon's option shape
 * directly. "gateway" (local/s3 modes) goes through the core-server gateway with
 * a scoped JWT; "s3" goes to R2 directly with STS temp credentials. See
 * src/core/server/STORAGE.md.
 */
export async function buildAddonStorageOptions(
  userId: string,
  repo: { id: string; orgId: string; r2BucketName: string | null },
  write: boolean,
): Promise<StorageOptions> {
  const expirationSeconds = config.get<number>(
    "storage.token-expiration-seconds",
  );
  const expirationMs = Date.now() + expirationSeconds * 1000;

  if (isR2Enabled()) {
    if (!repo.r2BucketName) {
      throw new Error("R2 storage is enabled but repo does not have a bucket");
    }
    const creds = await createR2TempCredentials(
      repo.r2BucketName,
      write ? "object-read-write" : "object-read-only",
      expirationSeconds,
    );
    return {
      storageType: "s3",
      jwtExpirationMs: expirationMs,
      s3Endpoint: getR2Endpoint(),
      s3Region: "auto",
      s3Bucket: repo.r2BucketName,
      s3AccessKeyId: creds.accessKeyId,
      s3SecretAccessKey: creds.secretAccessKey,
      s3SessionToken: creds.sessionToken,
      s3ForcePathStyle: false,
    };
  }

  const token = njwt.create(
    {
      iss: "checkpoint-vcs",
      sub: userId,
      userId,
      orgId: repo.orgId,
      repoId: repo.id,
      mode: write ? "write" : "read",
      basePath: `/${repo.orgId}/${repo.id}`,
    },
    config.get<string>("storage.jwt.signing-key"),
  );
  token.setExpiration(expirationMs);

  const serverUrl = config.get<string>("storage.backend-url.internal");
  return {
    storageType: "gateway",
    jwt: token.compact(),
    jwtExpirationMs: expirationMs,
    gatewayUrl: `${serverUrl}/storage`,
  };
}
