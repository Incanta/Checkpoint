import "server-only";

import config from "@incanta/config";

interface R2TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface R2TempCredentialsResponse {
  success: boolean;
  result: R2TempCredentials;
  errors: { code: number; message: string }[];
}

interface R2CreateBucketResponse {
  success: boolean;
  errors: { code: number; message: string }[];
}

export function isR2Enabled(): boolean {
  try {
    return config.get<boolean>("storage.r2.enabled");
  } catch {
    return false;
  }
}

export function getR2Endpoint(): string {
  const endpoint = config.get<string>("storage.r2.endpoint");
  if (endpoint) {
    return endpoint;
  }

  const accountId = config.get<string>("storage.r2.account-id");
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export async function createR2TempCredentials(
  bucketName: string,
  permission: "object-read-write" | "object-read-only",
  ttlSeconds = 600,
): Promise<R2TempCredentials> {
  const accountId = config.get<string>("storage.r2.account-id");
  const apiToken = await config.getWithSecrets<string>("storage.r2.api-token");
  const parentAccessKeyId = await config.getWithSecrets<string>(
    "storage.r2.access-key-id",
  );

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucket: bucketName,
        parentAccessKeyId,
        permission,
        ttlSeconds,
      }),
    },
  );

  const data = (await response.json()) as R2TempCredentialsResponse;

  if (!data.success) {
    throw new Error(
      `Failed to create R2 temp credentials: ${
        data.errors?.map((e) => e.message).join(", ") ?? response.statusText
      }`,
    );
  }

  return data.result;
}

export async function createR2Bucket(bucketName: string): Promise<void> {
  const accountId = config.get<string>("storage.r2.account-id");
  const apiToken = await config.getWithSecrets<string>("storage.r2.api-token");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: bucketName,
      }),
    },
  );

  if (response.status === 409) {
    // Bucket already exists — that's fine
    return;
  }

  if (!response.ok) {
    const data = (await response.json()) as R2CreateBucketResponse;
    throw new Error(
      `Failed to create R2 bucket "${bucketName}": ${
        data.errors?.map((e) => e.message).join(", ") ?? response.statusText
      }`,
    );
  }
}
