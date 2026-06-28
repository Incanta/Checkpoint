#include "main.h"

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
  if (StorageType && strcmp(StorageType, "local") == 0) {
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

  struct Longtail_StoreIndex* additional_store_index;
  int err = Longtail_ReadStoreIndexFromBuffer(
      additional_store_index_buffer,
      additional_store_index_size,
      &additional_store_index);

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
