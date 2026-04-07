#pragma once

#include <longtail.h>

struct WrapperAsyncHandle;

struct SeaweedFSStorageAPI {
  struct Longtail_StorageAPI m_SFSStorageAPI;

  char* m_URL;
  char* m_JWT;
  uint32_t m_NumAddedBlocks;
  struct WrapperAsyncHandle* m_Handle;
};

struct Longtail_StorageAPI* CreateSeaweedFSStorageAPI(
    const char* url,
    const char* jwt,
    struct WrapperAsyncHandle* handle = nullptr,
    uint64_t tokenExpirationMs = 0);
