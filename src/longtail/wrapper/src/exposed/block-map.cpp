#include "../util/upload-status.h"
#include "../util/verify-blocks.h"
#include "../util/version-index-io.h"
#include "main.h"

// A version's block map: a store index naming, for every chunk of one version
// index, the stored block that holds it. A submit computes it (the blocks it
// reused plus the ones it uploaded) and the server stores it next to the
// version index as versions/<name>.lsi.
//
// With block maps, reading a version needs only its own .lvi and .lsi, never
// the repo-wide store.lsi: that file grows with the repo and was downloaded in
// full by every pull and file read.
//
// The server vouches for a block map before storing it, because readers trust
// it: it must cover every chunk of the version (Longtail_ValidateStore), and
// every block it names must exist. A map that is already stored for a version
// is kept; any valid map for a version is as good as another.

static std::string BlockMapNameFor(const std::string& versionIndexName) {
  const std::string ext = ".lvi";
  if (versionIndexName.size() > ext.size() &&
      versionIndexName.compare(versionIndexName.size() - ext.size(), ext.size(), ext) == 0) {
    return versionIndexName.substr(0, versionIndexName.size() - ext.size()) + ".lsi";
  }
  return versionIndexName + ".lsi";
}

static void SetResult(WrapperAsyncHandle* handle, const std::string& result) {
  strncpy(handle->result, result.c_str(), sizeof(handle->result) - 1);
  handle->result[sizeof(handle->result) - 1] = '\0';
}

static int Fail(WrapperAsyncHandle* handle, int err, const std::string& step) {
  SetHandleStep(handle, step.c_str());
  handle->error = err;
  handle->settled = 1;
  return err;
}

int StoreBlockMap(
    const char* RemoteBasePath,
    const char* StorageType,
    const char* LocalStoragePath,
    const char* S3Endpoint,
    const char* S3Region,
    const char* S3Bucket,
    const char* S3AccessKeyId,
    const char* S3SecretAccessKey,
    const char* S3SessionToken,
    const char* VersionIndexName,
    const void* BlockMapBuffer,
    size_t BlockMapSize,
    WrapperAsyncHandle* handle) {
  struct Longtail_StorageAPI* storage_api;
  std::string basePath = RemoteBasePath;
  const bool is_local = StorageType && strcmp(StorageType, "local") == 0;
  if (is_local) {
    storage_api = Longtail_CreateFSStorageAPI();
    basePath = std::string(LocalStoragePath) + RemoteBasePath;
  } else {
    storage_api = CreateS3StorageAPI(S3Endpoint, S3Region, S3Bucket, S3AccessKeyId, S3SecretAccessKey, S3SessionToken);
  }
  if (!storage_api) {
    return Fail(handle, ENOMEM, "Failed to create storage api");
  }

  SetHandleStep(handle, "Reading block map");
  struct Longtail_StoreIndex* block_map = 0;
  int err = Longtail_ReadStoreIndexFromBuffer(BlockMapBuffer, BlockMapSize, &block_map);
  if (err) {
    SAFE_DISPOSE_API(storage_api);
    return Fail(handle, err, "The uploaded block map could not be read");
  }

  SetHandleStep(handle, "Reading version index");
  const std::string name = VersionIndexName;
  const std::string versionPath = basePath + "/versions/" + name;
  struct Longtail_VersionIndex* version_index = 0;
  err = version_index_io::ReadVerified(storage_api, versionPath.c_str(), name, &version_index);
  if (err) {
    Longtail_Free(block_map);
    SAFE_DISPOSE_API(storage_api);
    return Fail(handle, err, "The version index for the block map could not be read: " + versionPath);
  }

  SetHandleStep(handle, "Validating block map");
  if (*block_map->m_HashIdentifier != *version_index->m_HashIdentifier &&
      *block_map->m_BlockCount > 0) {
    Longtail_Free(version_index);
    Longtail_Free(block_map);
    SAFE_DISPOSE_API(storage_api);
    return Fail(handle, EBADMSG, "The block map uses a different hashing algorithm than its version index");
  }
  err = Longtail_ValidateStore(block_map, version_index);
  const uint32_t block_count = *block_map->m_BlockCount;
  Longtail_Free(version_index);
  if (err) {
    Longtail_Free(block_map);
    SAFE_DISPOSE_API(storage_api);
    return Fail(handle, EBADMSG, "The block map does not cover every chunk of its version index");
  }

  SetHandleStep(handle, "Verifying blocks");
  {
    std::string missing;
    err = verify_blocks::VerifyBlocksExist(storage_api, basePath, block_map, &missing);
    if (err) {
      Longtail_Free(block_map);
      SAFE_DISPOSE_API(storage_api);
      return Fail(handle, err, "A block named in the block map is not in storage: " + missing);
    }
  }
  Longtail_Free(block_map);

  const std::string mapPath = basePath + "/versions/" + BlockMapNameFor(name);
  bool written = false;
  if (!storage_api->IsFile(storage_api, mapPath.c_str())) {
    SetHandleStep(handle, "Writing block map");
    if (is_local) {
      // Beside the final name, then moved into place, so a reader never sees
      // half a block map.
      const std::string temp = mapPath + ".next";
      err = version_index_io::WriteBuffer(storage_api, temp.c_str(), BlockMapBuffer, BlockMapSize);
      if (!err) err = verify_blocks::ReplaceFileAtomically(temp, mapPath);
      if (err) Longtail_Storage_RemoveFile(storage_api, temp.c_str());
    } else {
      // An object PUT replaces atomically; its failure only shows here.
      err = version_index_io::WriteBuffer(storage_api, mapPath.c_str(), BlockMapBuffer, BlockMapSize);
      if (!err && S3StorageAPI_GetUploadFailures(storage_api)->Any()) err = EIO;
    }
    if (err) {
      SAFE_DISPOSE_API(storage_api);
      return Fail(handle, err, "Failed to write block map: " + mapPath);
    }
    written = true;
  }
  SAFE_DISPOSE_API(storage_api);

  std::stringstream result;
  result << "{\"written\":" << (written ? "true" : "false") << ",\"blocks\":" << block_count << "}";
  SetResult(handle, result.str());
  SetHandleStep(handle, "Completed");
  handle->error = 0;
  handle->settled = 1;
  return 0;
}

DLL_EXPORT WrapperAsyncHandle*
StoreBlockMapAsync(
    const char* RemoteBasePath,
    const char* StorageType,
    const char* LocalStoragePath,
    const char* S3Endpoint,
    const char* S3Region,
    const char* S3Bucket,
    const char* S3AccessKeyId,
    const char* S3SecretAccessKey,
    const char* S3SessionToken,
    const char* VersionIndexName,
    const void* BlockMapBuffer,
    size_t BlockMapSize,
    int LogLevel = 4) {
  SetLogging(LogLevel);

  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }
  memset(handle, 0, sizeof(WrapperAsyncHandle));
  SetHandleStep(handle, "Initializing");

  std::thread worker([=]() {
    int32_t err = StoreBlockMap(
        RemoteBasePath, StorageType, LocalStoragePath,
        S3Endpoint, S3Region, S3Bucket, S3AccessKeyId, S3SecretAccessKey, S3SessionToken,
        VersionIndexName, BlockMapBuffer, BlockMapSize, handle);
    if (err) {
      std::cerr << "Failed to store block map, " << err << ": " << handle->currentStep << std::endl;
    }
    // Last touch of the handle: the poller may free it from here on. See
    // wrapper-handle.h.
    handle->completed = 1;
  });
  worker.detach();

  return handle;
}
