#include "../util/upload-status.h"
#include "../util/verify-blocks.h"
#include "main.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#endif

using verify_blocks::ReplaceFileAtomically;
using verify_blocks::VerifyBlocksExist;

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
    handle->settled = 1;
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
    handle->settled = 1;
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
      handle->settled = 1;
      Longtail_Free(additional_store_index);
      SAFE_DISPOSE_API(remote_storage_api);
      return err;
    }
  }

  // No locking here. The caller holds the repo's store index lock for the
  // whole read, merge, and write below (see the core server's
  // storage/index-lock.ts). This function used to take a lock file itself by
  // checking for it and then creating it, which two merges could both do, and
  // which a merge that died left behind for every later one to wait on.
  std::string StoreFilePath = basePath + std::string("/store.lsi");

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
      handle->settled = 1;
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
      handle->settled = 1;
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
    handle->settled = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(remote_storage_api);
    return err;
  }

  if (is_local) {
    // Write beside the index and move it into place, so a reader sees the old
    // index or the new one and never part of either, and a crash mid-write
    // leaves the old one intact.
    std::string TempFilePath = StoreFilePath + ".next";
    err = Longtail_WriteStoreIndex(
        remote_storage_api,
        merged_store_index,
        TempFilePath.c_str());
    if (!err) {
      err = ReplaceFileAtomically(TempFilePath, StoreFilePath);
    }
    if (err) {
      Longtail_Storage_RemoveFile(remote_storage_api, TempFilePath.c_str());
    }
  } else {
    // A PUT to object storage replaces the object atomically already.
    err = Longtail_WriteStoreIndex(
        remote_storage_api,
        merged_store_index,
        StoreFilePath.c_str());
  }

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
    handle->settled = 1;
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
  handle->settled = 1;

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

    // Last touch of the handle: the poller may free it from here on. See
    // wrapper-handle.h.
    handle->completed = 1;
  });

  merge_thread.detach();

  return handle;
}
