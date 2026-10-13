#include "../util/upload-status.h"
#include "main.h"

#include <atomic>
#include <mutex>
#include <vector>

// Where FSBlockStore keeps a block, relative to the store root:
// chunks/<first 4 hex digits>/0x<16 hex digits>.lrb. This has to match
// GetBlockPath in longtail_fsblockstore.c (which is static, hence the copy)
// and the default extension Longtail_CreateFSBlockStoreAPI uses when SubmitSync
// passes none.
static std::string BlockPath(const std::string& basePath, TLongtail_Hash block_hash) {
  static const char* lut = "0123456789abcdef";
  char hex[17];
  for (int i = 0; i < 16; ++i) {
    hex[i] = lut[(block_hash >> (60 - 4 * i)) & 0xf];
  }
  hex[16] = 0;
  return basePath + "/chunks/" + std::string(hex, 4) + "/0x" + hex + ".lrb";
}

// Checks that every block in `store_index` exists under `basePath`. Returns 0
// if they all do, otherwise ENOENT with one missing path in `out_missing_path`.
//
// A block that cannot be confirmed counts as missing. On object storage IsFile
// is a HEAD that also reads a timeout or a 5xx as "no", so a "no" there is
// asked again before it is believed: rejecting a good submit over one bad HEAD
// would make the client upload everything a second time.
static int VerifyBlocksExist(
    struct Longtail_StorageAPI* storage_api,
    const std::string& basePath,
    const struct Longtail_StoreIndex* store_index,
    std::string* out_missing_path) {
  const uint32_t block_count = *store_index->m_BlockCount;
  if (block_count == 0) {
    return 0;
  }

  const bool is_object_storage = (storage_api->m_StorageFlags & LONGTAIL_STORAGE_FLAG_OBJECT_STORAGE) != 0;
  const int max_checks = is_object_storage ? 3 : 1;

  std::atomic<uint32_t> next_block{0};
  std::atomic<bool> found_missing{false};
  std::mutex missing_mutex;

  auto worker = [&]() {
    for (;;) {
      const uint32_t i = next_block.fetch_add(1);
      if (i >= block_count || found_missing.load()) {
        return;
      }
      const std::string path = BlockPath(basePath, store_index->m_BlockHashes[i]);
      bool exists = false;
      for (int check = 0; check < max_checks && !exists; ++check) {
        if (check > 0) {
          Longtail_Sleep(250000);  // 250ms
        }
        exists = storage_api->IsFile(storage_api, path.c_str()) != 0;
      }
      if (!exists) {
        std::lock_guard<std::mutex> lock(missing_mutex);
        if (!found_missing.exchange(true)) {
          *out_missing_path = path;
        }
        return;
      }
    }
  };

  // One HEAD per block is a network round trip on object storage, and a large
  // submit has thousands of blocks, so they are checked concurrently. The
  // adapters keep a curl handle per thread.
  const uint32_t thread_count = block_count < 16 ? block_count : 16;
  std::vector<std::thread> threads;
  threads.reserve(thread_count - 1);
  for (uint32_t t = 1; t < thread_count; ++t) {
    threads.emplace_back(worker);
  }
  worker();
  for (auto& thread : threads) {
    thread.join();
  }

  return found_missing.load() ? ENOENT : 0;
}

int Merge(
    const char* RemoteBasePath,
    const char* StorageType,
    const char* LocalStoragePath,
    const char* S3Endpoint,
    const char* S3Region,
    const char* S3Bucket,
    const char* S3AccessKeyId,
    const char* S3SecretAccessKey,
    const char* S3SessionToken,
    void* additional_store_index_buffer,
    size_t additional_store_index_size,
    WrapperAsyncHandle* handle) {
  // Server-side merge runs against the backend directly: "local" uses the
  // native filesystem (base path under LocalStoragePath); "s3" (covers s3 and
  // r2 modes) uses the S3 adapter with the server's full credentials.
  struct Longtail_StorageAPI* remote_storage_api;
  std::string basePath = RemoteBasePath;
  const bool is_local = StorageType && strcmp(StorageType, "local") == 0;
  if (is_local) {
    remote_storage_api = Longtail_CreateFSStorageAPI();
    basePath = std::string(LocalStoragePath) + RemoteBasePath;
  } else {
    remote_storage_api = CreateS3StorageAPI(S3Endpoint, S3Region, S3Bucket, S3AccessKeyId, S3SecretAccessKey, S3SessionToken);
  }

  if (!remote_storage_api) {
    SetHandleStep(handle, "Failed to create storage api");
    handle->error = ENOMEM;
    handle->completed = 1;
    return ENOMEM;
  }

  struct Longtail_StoreIndex* additional_store_index = 0;
  int err = Longtail_ReadStoreIndexFromBuffer(
      additional_store_index_buffer,
      additional_store_index_size,
      &additional_store_index);

  if (err) {
    SetHandleStep(handle, "The uploaded store index could not be read");
    handle->error = err;
    handle->completed = 1;
    SAFE_DISPOSE_API(remote_storage_api);
    return err;
  }

  // Before this submit's blocks are merged into the repo's store index, prove
  // they are in the store. The index is what every later submit deduplicates
  // against, so listing a block that is not there does more than break this
  // changelist: later submits skip uploading those chunks because the index
  // says the store has them, and their changelists come out unreadable too.
  {
    std::string missing_block_path;
    err = VerifyBlocksExist(remote_storage_api, basePath, additional_store_index, &missing_block_path);
    if (err) {
      std::string message = "A block listed in the uploaded store index is not in storage: " + missing_block_path;
      SetHandleStep(handle, message.c_str());
      handle->error = err;
      handle->completed = 1;
      Longtail_Free(additional_store_index);
      SAFE_DISPOSE_API(remote_storage_api);
      return err;
    }
  }

  std::string LockFilePath = basePath + std::string("/store.lsi.sync");
  std::string StoreFilePath = basePath + std::string("/store.lsi");

  while (remote_storage_api->IsFile(remote_storage_api, LockFilePath.c_str())) {
    Longtail_Sleep(100000);  // sleep for 100ms
  }

  Longtail_StorageAPI_HOpenFile out_open_file;
  err = Longtail_Storage_OpenWriteFile(remote_storage_api, LockFilePath.c_str(), 0, &out_open_file);

  if (err) {
    SetHandleStep(handle, "Failed to open lock file for writing");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(remote_storage_api);
    return err;
  }

  err = Longtail_Storage_Write(remote_storage_api, out_open_file, 0, 4, "lock");

  if (err) {
    SetHandleStep(handle, "Failed to write lock file");
    handle->error = err;
    handle->completed = 1;
    Longtail_Storage_CloseFile(remote_storage_api, out_open_file);
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(remote_storage_api);
    return err;
  }

  Longtail_Storage_CloseFile(remote_storage_api, out_open_file);

  struct Longtail_StoreIndex* existing_remote_store_index;

  if (!remote_storage_api->IsFile(remote_storage_api, StoreFilePath.c_str())) {
    // create new store index
    int err = Longtail_CreateStoreIndexFromBlocks(
        0,
        0,
        &existing_remote_store_index);

    if (err) {
      SetHandleStep(handle, "Failed to create new store index");
      handle->error = err;
      handle->completed = 1;
      int removeError = Longtail_Storage_RemoveFile(remote_storage_api, LockFilePath.c_str());
      if (removeError) {
        SetHandleStep(handle, "Failed to create new store index AND failed to remove lock file");
      }
      Longtail_Free(additional_store_index);
      SAFE_DISPOSE_API(remote_storage_api);
      return err;
    }
  } else {
    err = Longtail_ReadStoreIndex(
        remote_storage_api,
        StoreFilePath.c_str(),
        &existing_remote_store_index);

    if (err) {
      SetHandleStep(handle, "Failed to read the existing store index");
      handle->error = err;
      handle->completed = 1;
      int removeError = Longtail_Storage_RemoveFile(remote_storage_api, LockFilePath.c_str());
      if (removeError) {
        SetHandleStep(handle, "Failed to read the existing store index AND failed to remove lock file");
      }
      Longtail_Free(additional_store_index);
      SAFE_DISPOSE_API(remote_storage_api);
      return err;
    }
  }

  struct Longtail_StoreIndex* merged_store_index;
  err = Longtail_MergeStoreIndex(
      existing_remote_store_index,
      additional_store_index,
      &merged_store_index);

  if (err) {
    SetHandleStep(handle, "Failed to merge store indexes");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    int removeError = Longtail_Storage_RemoveFile(remote_storage_api, LockFilePath.c_str());
    if (removeError) {
      SetHandleStep(handle, "Failed to merge store indexes AND failed to remove lock file");
    }
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(remote_storage_api);
    return err;
  }

  err = Longtail_WriteStoreIndex(
      remote_storage_api,
      merged_store_index,
      StoreFilePath.c_str());

  // On object storage the PUT happens in CloseFile, which cannot return an
  // error, so Longtail_WriteStoreIndex reports success either way. Without
  // this the submit would go on to create a changelist whose blocks the store
  // index does not list. See upload-status.h.
  if (!err && !is_local && S3StorageAPI_GetUploadFailures(remote_storage_api)->Any()) {
    err = EIO;
  }

  if (err) {
    SetHandleStep(handle, "Failed to write merged store index");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    int removeError = Longtail_Storage_RemoveFile(remote_storage_api, LockFilePath.c_str());
    if (removeError) {
      SetHandleStep(handle, "Failed to write merged store index AND failed to remove lock file");
    }
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(remote_storage_api);
    return err;
  }

  err = Longtail_Storage_RemoveFile(remote_storage_api, LockFilePath.c_str());

  if (err) {
    SetHandleStep(handle, "Failed to remove lock file");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(remote_storage_api);
    return err;
  }

  // Sum this submit's new content bytes for incremental repo-size tracking.
  // additional_store_index holds only the missing (newly stored) chunks, so its
  // chunk sizes are the content bytes added by this submit (deduped). Reported
  // in the handle result; the app increments Repo.storageBytes by it.
  uint64_t addedBytes = 0;
  if (additional_store_index) {
    uint32_t chunkCount = *additional_store_index->m_ChunkCount;
    for (uint32_t i = 0; i < chunkCount; ++i) {
      addedBytes += additional_store_index->m_ChunkSizes[i];
    }
  }
  {
    std::stringstream resultStream;
    resultStream << "{\"addedBytes\":" << addedBytes << "}";
    std::string resultStr = resultStream.str();
    strncpy(handle->result, resultStr.c_str(), sizeof(handle->result) - 1);
    handle->result[sizeof(handle->result) - 1] = '\0';
  }

  SetHandleStep(handle, "Completed");
  handle->error = 0;
  handle->completed = 1;

  return 0;
}

DLL_EXPORT WrapperAsyncHandle*
MergeAsync(
    const char* RemoteBasePath,
    const char* StorageType,
    const char* LocalStoragePath,
    const char* S3Endpoint,
    const char* S3Region,
    const char* S3Bucket,
    const char* S3AccessKeyId,
    const char* S3SecretAccessKey,
    const char* S3SessionToken,
    void* additional_store_index_buffer,
    size_t additional_store_index_size,
    int LogLevel = 4) {
  SetLogging(LogLevel);

  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }

  memset(handle, 0, sizeof(WrapperAsyncHandle));

  SetHandleStep(handle, "Initializing");

  std::thread merge_thread([=]() {
    int32_t err = Merge(
        RemoteBasePath,
        StorageType,
        LocalStoragePath,
        S3Endpoint,
        S3Region,
        S3Bucket,
        S3AccessKeyId,
        S3SecretAccessKey,
        S3SessionToken,
        additional_store_index_buffer,
        additional_store_index_size, handle);

    if (err) {
      std::cerr << "Failed to merge store indexes, " << err << ": " << handle->currentStep << std::endl;
    }
  });

  merge_thread.detach();

  return handle;
}
