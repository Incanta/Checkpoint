#pragma once

#include <longtail.h>

struct WrapperAsyncHandle;

// Generic S3-compatible storage API (Cloudflare R2, AWS S3, MinIO, SeaweedFS
// S3 gateway, etc.) using AWS SigV4. Used by the client for R2-direct mode and
// by the server-side store-index merge for s3/r2 modes.
struct S3StorageAPI {
  struct Longtail_StorageAPI m_S3StorageAPI;

  char* m_Endpoint;    // e.g., "https://{accountId}.r2.cloudflarestorage.com"
  char* m_Region;      // SigV4 region (R2 uses "auto")
  char* m_BucketName;  // e.g., "checkpoint-{repoId}" or a shared bucket
  char* m_AccessKeyId;
  char* m_SecretAccessKey;
  char* m_SessionToken;
  uint32_t m_NumAddedBlocks;
  struct WrapperAsyncHandle* m_Handle;
};

struct Longtail_StorageAPI* CreateS3StorageAPI(
    const char* endpoint,
    const char* region,
    const char* bucketName,
    const char* accessKeyId,
    const char* secretAccessKey,
    const char* sessionToken,
    struct WrapperAsyncHandle* handle = nullptr,
    uint64_t tokenExpirationMs = 0);
