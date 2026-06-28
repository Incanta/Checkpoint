#pragma once

#include <longtail.h>

struct WrapperAsyncHandle;

// Checkpoint storage gateway adapter. The client talks to the core-server
// gateway (storage.mode local / s3) over HTTP with a Bearer JWT; the server
// holds the backend credentials. Object-store semantics (buffered writes, a
// single PUT on close, no temp+rename) like the S3 adapter. See STORAGE.md.
struct GatewayStorageAPI {
  struct Longtail_StorageAPI m_GatewayStorageAPI;

  char* m_GatewayUrl;  // e.g., "http://host:13001/storage"
  char* m_JWT;
  struct WrapperAsyncHandle* m_Handle;
};

struct Longtail_StorageAPI* CreateGatewayStorageAPI(
    const char* gatewayUrl,
    const char* jwt,
    struct WrapperAsyncHandle* handle = nullptr,
    uint64_t tokenExpirationMs = 0);
