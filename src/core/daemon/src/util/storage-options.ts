import type { StorageOptions } from "@checkpointvcs/longtail-addon";

// The shape returned by the app's storage.getToken (kept structural so the
// tRPC-inferred response is assignable). See src/core/server/STORAGE.md.
export interface StorageTokenResponse {
  kind: "gateway" | "r2";
  token: string;
  expiration: number;
  serverUrl: string;
  // Optional LAN-only address (and its derived gateway base). When set and the
  // host is HTTP-reachable, resolveStorageEndpoints prefers these over
  // serverUrl/gatewayUrl. Null/absent when the deployment did not configure one.
  serverUrlLan?: string | null;
  gatewayUrl?: string;
  gatewayUrlLan?: string | null;
  r2?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    endpoint: string;
    bucket: string;
  } | null;
}

/**
 * Quick HTTP reachability probe. Not an ICMP ping: issues a GET to the host's
 * root over the same HTTP(S) protocol the storage traffic uses (the core server
 * answers `GET /` with 200). Any HTTP response, even an error status, proves the
 * host is reachable; only a network failure or timeout counts as unreachable.
 */
async function isHttpReachable(
  url: string,
  timeoutMs = 1500,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Probe the origin root; we only care that the socket connects and the
    // server speaks HTTP, not about the specific status/body.
    const origin = new URL(url).origin;
    await fetch(origin, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the effective storage endpoints for this consumer. When the token
 * advertises a LAN-only address (serverUrlLan) and that host is HTTP-reachable
 * from here, swap serverUrl (and the gateway base) to the LAN address so blob
 * traffic stays on the local network; otherwise return the response unchanged.
 */
export async function resolveStorageEndpoints(
  t: StorageTokenResponse,
): Promise<StorageTokenResponse> {
  if (!t.serverUrlLan) {
    return t;
  }

  if (!(await isHttpReachable(t.serverUrlLan))) {
    return t;
  }

  return {
    ...t,
    serverUrl: t.serverUrlLan,
    gatewayUrl: t.gatewayUrlLan ?? t.gatewayUrl,
  };
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
