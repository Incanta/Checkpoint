#include "main.h"

int Merge(
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    void* additional_store_index_buffer,
    size_t additional_store_index_size,
    WrapperAsyncHandle* handle) {
  struct Longtail_StorageAPI* storage_api = CreateSeaweedFSStorageAPI(FilerUrl, JWT);

  if (!storage_api) {
    SetHandleStep(handle, "Failed to create seaweed storage api");
    handle->error = ENOMEM;
    handle->completed = 1;
    return ENOMEM;
  }

  struct Longtail_StoreIndex* additional_store_index;
  int err = Longtail_ReadStoreIndexFromBuffer(
      additional_store_index_buffer,
      additional_store_index_size,
      &additional_store_index);

  std::string LockFilePath = RemoteBasePath + std::string("/store.lsi.sync");
  std::string StoreFilePath = RemoteBasePath + std::string("/store.lsi");

  while (storage_api->IsFile(storage_api, LockFilePath.c_str())) {
    Longtail_Sleep(100000);  // sleep for 100ms
  }

  Longtail_StorageAPI_HOpenFile out_open_file;
  err = Longtail_Storage_OpenWriteFile(storage_api, LockFilePath.c_str(), 0, &out_open_file);

  if (err) {
    SetHandleStep(handle, "Failed to open lock file for writing");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(storage_api);
    return err;
  }

  err = Longtail_Storage_Write(storage_api, out_open_file, 0, 4, "lock");

  if (err) {
    SetHandleStep(handle, "Failed to write lock file");
    handle->error = err;
    handle->completed = 1;
    Longtail_Storage_CloseFile(storage_api, out_open_file);
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(storage_api);
    return err;
  }

  Longtail_Storage_CloseFile(storage_api, out_open_file);

  struct Longtail_StoreIndex* existing_remote_store_index;

  if (!storage_api->IsFile(storage_api, StoreFilePath.c_str())) {
    // create new store index
    int err = Longtail_CreateStoreIndexFromBlocks(
        0,
        0,
        &existing_remote_store_index);

    if (err) {
      SetHandleStep(handle, "Failed to create new store index");
      handle->error = err;
      handle->completed = 1;
      int removeError = Longtail_Storage_RemoveFile(storage_api, LockFilePath.c_str());
      if (removeError) {
        SetHandleStep(handle, "Failed to create new store index AND failed to remove lock file");
      }
      Longtail_Free(additional_store_index);
      SAFE_DISPOSE_API(storage_api);
      return err;
    }
  } else {
    err = Longtail_ReadStoreIndex(
        storage_api,
        StoreFilePath.c_str(),
        &existing_remote_store_index);

    if (err) {
      SetHandleStep(handle, "Failed to read the existing store index");
      handle->error = err;
      handle->completed = 1;
      int removeError = Longtail_Storage_RemoveFile(storage_api, LockFilePath.c_str());
      if (removeError) {
        SetHandleStep(handle, "Failed to read the existing store index AND failed to remove lock file");
      }
      Longtail_Free(additional_store_index);
      SAFE_DISPOSE_API(storage_api);
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
    int removeError = Longtail_Storage_RemoveFile(storage_api, LockFilePath.c_str());
    if (removeError) {
      SetHandleStep(handle, "Failed to merge store indexes AND failed to remove lock file");
    }
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(storage_api);
    return err;
  }

  err = Longtail_WriteStoreIndex(
      storage_api,
      merged_store_index,
      StoreFilePath.c_str());

  if (err) {
    SetHandleStep(handle, "Failed to write merged store index");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    int removeError = Longtail_Storage_RemoveFile(storage_api, LockFilePath.c_str());
    if (removeError) {
      SetHandleStep(handle, "Failed to write merged store index AND failed to remove lock file");
    }
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(storage_api);
    return err;
  }

  err = Longtail_Storage_RemoveFile(storage_api, LockFilePath.c_str());

  if (err) {
    SetHandleStep(handle, "Failed to remove lock file");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(additional_store_index);
    SAFE_DISPOSE_API(storage_api);
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
    const char* FilerUrl,
    const char* JWT,
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
        FilerUrl,
        JWT,
        additional_store_index_buffer,
        additional_store_index_size, handle);

    if (err) {
      std::cerr << "Failed to merge store indexes, " << err << ": " << handle->currentStep << std::endl;
    }
  });

  merge_thread.detach();

  return handle;
}
