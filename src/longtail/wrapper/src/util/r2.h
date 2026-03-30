#pragma once

#include <longtail.h>

struct R2StorageAPI {
  struct Longtail_StorageAPI m_R2StorageAPI;

  char* m_Endpoint;    // e.g., "https://{accountId}.r2.cloudflarestorage.com"
  char* m_BucketName;  // e.g., "checkpoint-{repoId}"
  char* m_AccessKeyId;
  char* m_SecretAccessKey;
  char* m_SessionToken;
  uint32_t m_NumAddedBlocks;
};

struct Longtail_StorageAPI* CreateR2StorageAPI(
    const char* endpoint,
    const char* bucketName,
    const char* accessKeyId,
    const char* secretAccessKey,
    const char* sessionToken);
