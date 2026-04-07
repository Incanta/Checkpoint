import { S3Client } from "@aws-sdk/client-s3";
import config from "@incanta/config";

let cachedClient: S3Client | null = null;

export function getR2Client(): S3Client {
  if (cachedClient) {
    return cachedClient;
  }

  const accountId = config.get<string>("storage.r2.account-id");
  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.get<string>("storage.r2.access-key-id"),
      secretAccessKey: config.get<string>("storage.r2.secret-access-key"),
    },
  });

  return cachedClient;
}

export function getR2Endpoint(): string {
  const accountId = config.get<string>("storage.r2.account-id");
  return `https://${accountId}.r2.cloudflarestorage.com`;
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

export async function getBucketUsageR2(bucket: string): Promise<number> {
  const accountId = config.get<string>("storage.r2.account-id");
  const cfApiToken = config.get<string>("storage.r2.api-token");

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

  const data: R2UsageResponse = await response.json();

  if (!data.success) {
    throw new Error(
      `Cloudflare R2 usage API error: ${JSON.stringify(data.errors)}`,
    );
  }

  return parseInt(data.result.payloadSize, 10);
}
