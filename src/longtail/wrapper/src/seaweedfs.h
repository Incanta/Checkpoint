#pragma once

#include <longtail.h>

struct SeaweedFSStorageAPI {
  struct Longtail_StorageAPI m_SFSStorageAPI;

  char* m_URL;
  char* m_JWT;
  uint32_t m_NumAddedBlocks;
};

struct Longtail_StorageAPI* CreateSeaweedFSStorageAPI(const char* url, const char* jwt);
