import "server-only";

import config from "@incanta/config";
import { hasFeature, isLicenseManager } from "./license-utils";
import { getInstanceTier } from "./license-client";

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

interface R2DeleteBucketResponse {
  success: boolean;
  errors: { code: number; message: string }[];
}

interface R2UsageResponse {
  success: boolean;
  errors: unknown[];
  messages: unknown[];
  result: {
    end: string;
    payloadSize: string;
    metadataSize: string;
    objectCount: string;
    uploadCount: string;
    infrequentAccessPayloadSize: string;
    infrequentAccessMetadataSize: string;
    infrequentAccessObjectCount: string;
    infrequentAccessUploadCount: string;
  };
}

export function isR2Enabled(): boolean {
  if (config.get<string>("storage.mode") === "r2") {
    return isLicenseManager() || hasFeature(getInstanceTier(), "r2Storage");
  }

  return false;
}

export function getR2Endpoint(): string {
  const accountId = config.get<string>("storage.r2.account-id");
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export async function createR2TempCredentials(
  bucketName: string,
  permission: "object-read-write" | "object-read-only",
  ttlSeconds: number,
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

  const locationHint =
    config.tryGet<string>("storage.r2.location-override") || undefined;

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
        locationHint,
        storageClass: "Standard",
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

export async function deleteR2Bucket(bucketName: string): Promise<boolean> {
  const accountId = config.get<string>("storage.r2.account-id");
  const apiToken = await config.getWithSecrets<string>("storage.r2.api-token");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    },
  );

  if (response.status === 404) {
    // Bucket doesn't exist — already cleaned up
    return true;
  }

  if (response.ok) {
    return true;
  }

  // Bucket might not be empty — log the error
  const data = (await response.json()) as R2DeleteBucketResponse;
  const errorMsg =
    data.errors?.map((e) => e.message).join(", ") ?? response.statusText;
  throw new Error(`Failed to delete R2 bucket "${bucketName}": ${errorMsg}`);
}

export async function getBucketUsageR2(bucket: string): Promise<number> {
  const accountId = config.get<string>("storage.r2.account-id");
  const cfApiToken = await config.getWithSecrets<string>(
    "storage.r2.api-token",
  );

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/usage`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfApiToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Cloudflare R2 usage API returned ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as R2UsageResponse;

  if (!data.success) {
    throw new Error(
      `Cloudflare R2 usage API error: ${JSON.stringify(data.errors)}`,
    );
  }

  return parseInt(data.result.payloadSize, 10);
}
