#pragma once

#include <longtail.h>

struct WrapperAsyncHandle;
struct UploadFailures;

// Checkpoint storage gateway adapter. The client talks to the core-server
// gateway (storage.mode local / s3) over HTTP with a Bearer JWT; the server
// holds the backend credentials. Object-store semantics (buffered writes, a
// single PUT on close, no temp+rename) like the S3 adapter. See STORAGE.md.
struct GatewayStorageAPI {
  struct Longtail_StorageAPI m_GatewayStorageAPI;

  char* m_GatewayUrl;  // e.g., "http://host:13001/storage"
  char* m_JWT;
  struct WrapperAsyncHandle* m_Handle;
  struct UploadFailures* m_UploadFailures;
};

// The sticky record of PUTs that failed for good on this adapter. CloseFile
// cannot return an error, so anything that writes through the adapter must
// check this before treating the write as done. See upload-status.h.
struct UploadFailures* GatewayStorageAPI_GetUploadFailures(struct Longtail_StorageAPI* storage_api);

struct Longtail_StorageAPI* CreateGatewayStorageAPI(
    const char* gatewayUrl,
    const char* jwt,
    struct WrapperAsyncHandle* handle = nullptr,
    uint64_t tokenExpirationMs = 0);
