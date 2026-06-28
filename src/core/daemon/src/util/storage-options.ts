import type { StorageOptions } from "@checkpointvcs/longtail-addon";

// The shape returned by the app's storage.getToken (kept structural so the
// tRPC-inferred response is assignable). See src/core/server/STORAGE.md.
export interface StorageTokenResponse {
  kind: "gateway" | "r2";
  token: string;
  expiration: number;
  serverUrl: string;
  gatewayUrl?: string;
  r2?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    endpoint: string;
    bucket: string;
  } | null;
}

/**
 * Map a getToken descriptor to the addon's client storage options. "gateway"
 * (local/s3 modes) talks to the core-server gateway with the Bearer JWT; "r2"
 * talks to R2 directly via the addon's S3 adapter with STS temp credentials.
 */
export function toStorageOptions(t: StorageTokenResponse): StorageOptions {
  if (t.kind === "r2") {
    if (!t.r2) throw new Error("r2 token response missing credentials");
    return {
      storageType: "s3",
      jwt: t.token,
      jwtExpirationMs: t.expiration * 1000,
      s3Endpoint: t.r2.endpoint,
      s3Region: "auto",
      s3Bucket: t.r2.bucket,
      s3AccessKeyId: t.r2.accessKeyId,
      s3SecretAccessKey: t.r2.secretAccessKey,
      s3SessionToken: t.r2.sessionToken,
      s3ForcePathStyle: false,
    };
  }
  if (!t.gatewayUrl) throw new Error("gateway token response missing gatewayUrl");
  return {
    storageType: "gateway",
    jwt: t.token,
    jwtExpirationMs: t.expiration * 1000,
    gatewayUrl: t.gatewayUrl,
  };
}
