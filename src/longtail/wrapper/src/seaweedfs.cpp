#include "seaweedfs.h"

#include <cpr/cpr.h>
#include <errno.h>
#include <inttypes.h>
#include <longtail.h>
#include <longtail_platform.h>
#include <string.h>

#include <iostream>

#include "json.hpp"

using json = nlohmann::json;

struct SeaweedFSStorageAPI_OpenFile {
  char* m_Path;
};

static void SeaweedFSStorageAPI_Dispose(struct Longtail_API* storage_api) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p")
  MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG)

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return);

  Longtail_Free(storage_api);
}

static int SeaweedFSStorageAPI_OpenReadFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_open_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)Longtail_Alloc(
      "SeaweedFSStorageAPI_OpenFile",
      sizeof(struct SeaweedFSStorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  memset(open_file, 0, sizeof(struct SeaweedFSStorageAPI_OpenFile));

  open_file->m_Path = Longtail_Strdup(path);

  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;

  return 0;
}

static int SeaweedFSStorageAPI_GetSize(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t* out_size) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(out_size, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_size != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  cpr::Response r = cpr::Head(cpr::Url{std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path)},
                              cpr::Bearer{std::string(seaweed_storage_api->m_JWT)});

  if (r.status_code >= 200 && r.status_code < 300) {
    std::string length = r.header["Content-Length"];
    *out_size = std::stoull(length);
    return 0;
  }

  return r.status_code;
}

static int SeaweedFSStorageAPI_Read(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    void* output) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(offset, "%" PRIu64),
      LONGTAIL_LOGFIELD(length, "%" PRIu64),
      LONGTAIL_LOGFIELD(output, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, output != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  cpr::Response r = cpr::Get(cpr::Url{std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path)},
                             cpr::Bearer{std::string(seaweed_storage_api->m_JWT)},
                             cpr::ReserveSize{1024 * 1024 * 8});

  if (r.status_code >= 200 && r.status_code < 300) {
    if (offset > r.text.length()) {
      return -1;
    }

    uint64_t adjustedLength = r.text.length() - offset;
    if (length < adjustedLength) {
      adjustedLength = length;
    }

    memcpy(output, r.text.c_str() + offset, adjustedLength);
  } else {
    return -1;
  }

  return 0;
}

static int SeaweedFSStorageAPI_OpenWriteFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint64_t initial_size,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(initial_size, "%" PRIu64),
      LONGTAIL_LOGFIELD(out_open_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)Longtail_Alloc(
      "SeaweedFSStorageAPI_OpenFile",
      sizeof(struct SeaweedFSStorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  memset(open_file, 0, sizeof(struct SeaweedFSStorageAPI_OpenFile));

  open_file->m_Path = Longtail_Strdup(path);

  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;

  seaweed_storage_api->m_NumAddedBlocks++;

  return 0;
}

static int SeaweedFSStorageAPI_Write(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    const void* input) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(offset, "%" PRIu64),
      LONGTAIL_LOGFIELD(length, "%" PRIu64),
      LONGTAIL_LOGFIELD(input, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, input != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path);

  std::cout << "SeaweedFSStorageAPI_Write: " << url << std::endl;

  cpr::Response r = cpr::Post(cpr::Url{url},
                              cpr::Bearer{std::string(seaweed_storage_api->m_JWT)},
                              cpr::Multipart{
                                  {"name", cpr::Buffer{(char*)input, (char*)input + length, "chunk.bin"}}});

  if (r.status_code >= 200 && r.status_code < 300) {
    return 0;
  } else {
    return -1;
  }
}

static int SeaweedFSStorageAPI_SetSize(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t length) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(length, "%" PRIu64)
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);

  return 0;
}

static int SeaweedFSStorageAPI_SetPermissions(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint16_t permissions) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(permissions, "%u")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  return 0;
}

static int SeaweedFSStorageAPI_GetPermissions(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint16_t* out_permissions) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_permissions, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  *out_permissions = 0644;

  return 0;
}

static void SeaweedFSStorageAPI_CloseFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HOpenFile f) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return);

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);
}

static int SeaweedFSStorageAPI_CreateDir(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  return 0;
}

static int SeaweedFSStorageAPI_RenameFile(struct Longtail_StorageAPI* storage_api, const char* source_path, const char* target_path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(source_path, "%s"),
      LONGTAIL_LOGFIELD(target_path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, source_path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, target_path != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(target_path) + "?mv.from=" + std::string(source_path);

  std::cout << "SeaweedFSStorageAPI_RenameFile: " << url << std::endl;

  cpr::Response r = cpr::Post(cpr::Url{url},
                              cpr::Bearer{std::string(seaweed_storage_api->m_JWT)});

  return r.status_code >= 200 && r.status_code < 300 ? 0 : r.status_code;
}

static char* SeaweedFSStorageAPI_ConcatPath(struct Longtail_StorageAPI* storage_api, const char* root_path, const char* sub_path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(root_path, "%s"),
      LONGTAIL_LOGFIELD(sub_path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, root_path != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, sub_path != 0, return 0);

  std::string result = std::string(root_path) + "/" + std::string(sub_path);
  char* path = (char*)Longtail_Alloc("ConcatPath", result.length() + 1);
  if (!path) {
    return 0;
  }
  strcpy(path, result.c_str());

  return path;
}

static int SeaweedFSStorageAPI_IsDir(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  std::cerr << "SeaweedFSStorageAPI_IsDir called (not expected)" << std::endl;

  return false;
}

static int SeaweedFSStorageAPI_IsFile(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  cpr::Response r = cpr::Head(cpr::Url{std::string(seaweed_storage_api->m_URL) + std::string(path)},
                              cpr::Bearer{std::string(seaweed_storage_api->m_JWT)});

  return r.status_code >= 200 && r.status_code < 300;
}

static int SeaweedFSStorageAPI_RemoveDir(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  std::cerr << "SeaweedFSStorageAPI_RemoveDir called (not expected)" << std::endl;

  return 0;
}

static int SeaweedFSStorageAPI_RemoveFile(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  cpr::Response r = cpr::Delete(cpr::Url{std::string(seaweed_storage_api->m_URL) + std::string(path)},
                                cpr::Bearer{std::string(seaweed_storage_api->m_JWT)});

  if (r.status_code >= 200 && r.status_code < 300) {
    return 0;
  }

  return r.status_code;
}

static int SeaweedFSStorageAPI_StartFind(struct Longtail_StorageAPI* storage_api, const char* path, Longtail_StorageAPI_HIterator* out_iterator) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_iterator, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_iterator != 0, return EINVAL);

  std::cerr << "SeaweedFSStorageAPI_StartFind called (not expected)" << std::endl;

  return 0;
}

static int SeaweedFSStorageAPI_FindNext(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HIterator iterator) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(iterator, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, iterator != 0, return EINVAL);

  std::cerr << "SeaweedFSStorageAPI_FindNext called (not expected)" << std::endl;

  return 0;
}

static void SeaweedFSStorageAPI_CloseFind(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HIterator iterator) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(iterator, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return);
  LONGTAIL_VALIDATE_INPUT(ctx, iterator != 0, return);
}

static int SeaweedFSStorageAPI_GetEntryProperties(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HIterator iterator,
    struct Longtail_StorageAPI_EntryProperties* out_properties) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(iterator, "%s"),
      LONGTAIL_LOGFIELD(out_properties, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, iterator != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, out_properties != 0, return EINVAL);

  std::cerr << "SeaweedFSStorageAPI_GetEntryProperties called (not expected)" << std::endl;

  return 1;
}

static int SeaweedFSStorageAPI_LockFile(struct Longtail_StorageAPI* storage_api, const char* path, Longtail_StorageAPI_HLockFile* out_lock_file) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_lock_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, path != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, out_lock_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  char* lock_path = (char*)Longtail_Alloc("SeaweedFSStorageAPI_LockFile", strlen(path) + 5 + 1);
  if (!lock_path) {
    return ENOMEM;
  }

  strcpy(lock_path, path);
  strcat(lock_path, ".lock");
  memset(lock_path + strlen(path) + 5, 0, 1);

  std::cout << "SeaweedFSStorageAPI_LockFile: " << lock_path << std::endl;

  while (SeaweedFSStorageAPI_IsFile(storage_api, lock_path)) {
    std::cerr << "SeaweedFSStorageAPI_LockFile: waiting for file not to exist: " << lock_path << std::endl;
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)Longtail_Alloc(
      "SeaweedFSStorageAPI_LockFile",
      sizeof(struct SeaweedFSStorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(lock_path);

  cpr::Response r = cpr::Post(cpr::Url{url},
                              cpr::Bearer{std::string(seaweed_storage_api->m_JWT)},
                              cpr::Multipart{
                                  {"name", ""}});

  if (r.status_code >= 200 && r.status_code < 300) {
    memset(open_file, 0, sizeof(struct SeaweedFSStorageAPI_OpenFile));

    open_file->m_Path = lock_path;

    *out_lock_file = (Longtail_StorageAPI_HLockFile)open_file;

    return 0;
  } else {
    std::cerr << "SeaweedFSStorageAPI_LockFile: failed to lock file: " << path << ". Code: " << r.status_code << ". Status line: " << r.status_line << std::endl;
    return -1;
  }
}

static int SeaweedFSStorageAPI_UnlockFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HLockFile lock_file) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(lock_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, lock_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)lock_file;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path);

  std::cout << "SeaweedFSStorageAPI_UnlockFile: " << url << std::endl;

  cpr::Response r = cpr::Delete(cpr::Url{url},
                                cpr::Bearer{std::string(seaweed_storage_api->m_JWT)});

  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);

  return r.status_code == 404 || (r.status_code >= 200 && r.status_code < 300) ? 0 : r.status_code;
}

static char* SeaweedFSStorageAPI_GetParentPath(
    struct Longtail_StorageAPI* storage_api,
    const char* path) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_OFF);

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return 0);

  return Longtail_GetParentPath(path);
}

static int SeaweedFSStorageAPI_MapFile(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    Longtail_StorageAPI_HFileMap* out_file_map,
    const void** out_data_ptr) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(offset, "%" PRIu64),
      LONGTAIL_LOGFIELD(length, "%" PRIu64),
      LONGTAIL_LOGFIELD(out_file_map, "%p"),
      LONGTAIL_LOGFIELD(out_data_ptr, "%p"),
      MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_OFF);

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, length > 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, out_file_map != 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, out_data_ptr != 0, return EINVAL)

  std::cerr << "SeaweedFSStorageAPI_MapFile called (not expected)" << std::endl;

  return 0;
}

static void SeaweedFSStorageAPI_UnmapFile(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HFileMap m) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(m, "%p"),
      MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_OFF);

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return)
  LONGTAIL_VALIDATE_INPUT(ctx, m != 0, return)

  std::cerr << "FSStorageAPI_UnmapFile called (not expected)" << std::endl;
}

static int SeaweedFSStorageAPI_Init(
    void* mem,
    struct Longtail_StorageAPI** out_storage_api) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(mem, "%p"),
      LONGTAIL_LOGFIELD(out_storage_api, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_VALIDATE_INPUT(ctx, mem != 0, return 0);
  struct Longtail_StorageAPI* api = Longtail_MakeStorageAPI(
      mem,
      SeaweedFSStorageAPI_Dispose,
      SeaweedFSStorageAPI_OpenReadFile,
      SeaweedFSStorageAPI_GetSize,
      SeaweedFSStorageAPI_Read,
      SeaweedFSStorageAPI_OpenWriteFile,
      SeaweedFSStorageAPI_Write,
      SeaweedFSStorageAPI_SetSize,
      SeaweedFSStorageAPI_SetPermissions,
      SeaweedFSStorageAPI_GetPermissions,
      SeaweedFSStorageAPI_CloseFile,
      SeaweedFSStorageAPI_CreateDir,
      SeaweedFSStorageAPI_RenameFile,
      SeaweedFSStorageAPI_ConcatPath,
      SeaweedFSStorageAPI_IsDir,
      SeaweedFSStorageAPI_IsFile,
      SeaweedFSStorageAPI_RemoveDir,
      SeaweedFSStorageAPI_RemoveFile,
      SeaweedFSStorageAPI_StartFind,
      SeaweedFSStorageAPI_FindNext,
      SeaweedFSStorageAPI_CloseFind,
      SeaweedFSStorageAPI_GetEntryProperties,
      SeaweedFSStorageAPI_LockFile,
      SeaweedFSStorageAPI_UnlockFile,
      SeaweedFSStorageAPI_GetParentPath,
      SeaweedFSStorageAPI_MapFile,
      SeaweedFSStorageAPI_UnmapFile);
  *out_storage_api = api;
  return 0;
}

struct Longtail_StorageAPI* CreateSeaweedFSStorageAPI(const char* url, const char* jwt) {
  MAKE_LOG_CONTEXT(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG)

  void* mem = (struct FSStorageAPI*)Longtail_Alloc("SeaweedFSStorageAPI", sizeof(struct SeaweedFSStorageAPI));
  if (!mem) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "Longtail_Alloc() failed with %d", ENOMEM)
    return 0;
  }
  struct Longtail_StorageAPI* storage_api;
  int err = SeaweedFSStorageAPI_Init(mem, &storage_api);
  if (err) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "SeaweedFSStorageAPI_Init() failed with %d", err)
    return 0;
  }

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;
  seaweed_storage_api->m_URL = strdup(url);  // TODO MIKE HERE not sure if this is the right way to alloc this (or how do we dealloc)
  seaweed_storage_api->m_JWT = strdup(jwt);
  seaweed_storage_api->m_NumAddedBlocks = 0;

  return storage_api;
}
