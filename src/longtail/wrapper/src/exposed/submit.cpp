#include "../util/cancel.h"
#include "../util/existing-content.h"
#include "../util/flush.h"
#include "../util/progress.h"
#include "main.h"

int32_t Submit(
    const char* BranchName,
    const char* Message,
    uint32_t TargetChunkSize,
    uint32_t TargetBlockSize,
    uint32_t MaxChunksPerBlock,
    uint32_t MinBlockUsagePercent,
    const char* HashingAlgo,
    const char* CompressionAlgo,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* BackendUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    const char* API_JWT,
    uint32_t NumModifications,
    const Modification* Modifications,
    WrapperAsyncHandle* handle) {
  struct Longtail_HashRegistryAPI* hash_registry = Longtail_CreateFullHashRegistry();
  struct Longtail_JobAPI* job_api = Longtail_CreateBikeshedJobAPI(1, 0);
  struct Longtail_CompressionRegistryAPI* compression_registry = Longtail_CreateFullCompressionRegistry();

  struct Longtail_StorageAPI* file_storage_api = Longtail_CreateFSStorageAPI();
  struct Longtail_StorageAPI* seaweed_storage_api = CreateSeaweedFSStorageAPI(FilerUrl, JWT);

  struct Longtail_BlockStoreAPI* store_block_fsstore_api = Longtail_CreateFSBlockStoreAPI(
      job_api,
      seaweed_storage_api,
      RemoteBasePath,
      0,
      EnableMmapBlockStore);

  struct Longtail_BlockStoreAPI* store_block_store_api = Longtail_CreateCompressBlockStoreAPI(
      store_block_fsstore_api,
      compression_registry);

  CheckpointCancelAPI cancel_api(handle);
  Longtail_CancelAPI_HCancelToken cancel_token = Longtail_CancelAPI_HCancelToken();

  struct Longtail_VersionIndex* source_version_index = 0;

  struct Longtail_HashAPI* hash_api;
  int HashingType = ParseHashingType(HashingAlgo);
  int err = hash_registry->GetHashAPI(hash_registry, HashingType, &hash_api);

  if (err) {
    SetHandleStep(handle, "Failed to get hash API");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    SAFE_DISPOSE_API(hash_registry);
    return err;
  }

  struct Longtail_ChunkerAPI* chunker_api = Longtail_CreateHPCDCChunkerAPI();
  if (!chunker_api) {
    SetHandleStep(handle, "Failed to allocate memory for chunker API");
    handle->error = ENOMEM;
    handle->completed = 1;
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return ENOMEM;
  }

  uint32_t path_data_size = 0;
  for (uint32_t i = 0; i < NumModifications; ++i) {
    path_data_size += (uint32_t)strlen(Modifications[i].Path) + 1;
  }

  size_t file_infos_size = sizeof(struct Longtail_FileInfos) +
                           sizeof(uint32_t) * NumModifications +  // m_Permissions[path_count]
                           sizeof(uint32_t) * NumModifications +  // m_Offsets[path_count]
                           sizeof(uint64_t) * NumModifications +  // m_Sizes[path_count]
                           path_data_size +
                           33 * NumModifications;  // 33 is the maximum length of a SeaweedFS FileID

  struct Longtail_FileInfos* file_infos = (struct Longtail_FileInfos*)Longtail_Alloc("ModificationsFileInfos", file_infos_size);
  if (!file_infos) {
    SetHandleStep(handle, "Failed to allocate memory for file infos");
    handle->error = ENOMEM;
    handle->completed = 1;
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return ENOMEM;
  }

  char* p = (char*)&file_infos[1];
  file_infos->m_Count = 0;
  file_infos->m_PathDataSize = 0;
  file_infos->m_Sizes = (uint64_t*)p;
  p += sizeof(uint64_t) * NumModifications;
  file_infos->m_PathStartOffsets = (uint32_t*)p;
  p += sizeof(uint32_t) * NumModifications;
  file_infos->m_Permissions = (uint16_t*)p;
  p += sizeof(uint16_t) * NumModifications;
  file_infos->m_PathData = p;

  uint32_t offset = 0;
  uint32_t file_infos_num = 0;
  for (uint32_t i = 0; i < NumModifications; ++i) {
    if (IsHandleCanceled(handle)) {
      Longtail_Free(source_version_index);
      SAFE_DISPOSE_API(chunker_api);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(store_block_fsstore_api);
      SAFE_DISPOSE_API(file_storage_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return ECANCELED;
    }

    if (Modifications[i].IsDelete) {
      continue;
    }

    uint32_t length = (uint32_t)strlen(Modifications[i].Path) + 1;

    HLongtail_OpenFile file_handle;
    char* filePath = Longtail_ConcatPath(LocalRootPath, Modifications[i].Path);
    Longtail_OpenReadFile(filePath, &file_handle);
    Longtail_GetFileSize(file_handle, &file_infos->m_Sizes[file_infos_num]);
    Longtail_CloseFile(file_handle);
    Longtail_Free(filePath);

    file_infos->m_Permissions[file_infos_num] = 0644;  // should never be a directory
    file_infos->m_PathStartOffsets[file_infos_num] = offset;
    memmove(&file_infos->m_PathData[offset], Modifications[i].Path, length);
    offset += length;
    file_infos_num++;
  }
  file_infos->m_PathDataSize = offset;
  file_infos->m_Count = file_infos_num;

  uint32_t CompressionType = ParseCompressionType(CompressionAlgo);

  uint32_t* tags = (uint32_t*)Longtail_Alloc(0, sizeof(uint32_t) * file_infos->m_Count);
  for (uint32_t i = 0; i < file_infos->m_Count; ++i) {
    tags[i] = CompressionType;
  }

  if (IsHandleCanceled(handle)) {
    Longtail_Free(tags);
    Longtail_Free(file_infos);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return ECANCELED;
  }

  struct Longtail_ProgressAPI* progress = MakeProgressAPI("Indexing version");
  if (progress) {
    SetHandleStep(handle, "Indexing version");
    err = Longtail_CreateVersionIndex(
        file_storage_api,
        hash_api,
        chunker_api,
        job_api,
        progress,
        &cancel_api.m_API,
        cancel_token,
        LocalRootPath,
        file_infos,
        tags,
        TargetChunkSize,
        EnableMmapIndexing,
        &source_version_index);
    SAFE_DISPOSE_API(progress);
    progress = 0;
  } else {
    err = ENOMEM;
  }

  Longtail_Free(tags);
  Longtail_Free(file_infos);

  if (err) {
    SetHandleStep(handle, "Failed to create version index");
    handle->error = err;
    handle->completed = 1;
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  struct Longtail_StoreIndex* existing_remote_store_index;
  err = SyncGetExistingContent(
      store_block_store_api,
      *source_version_index->m_ChunkCount,
      source_version_index->m_ChunkHashes,
      MinBlockUsagePercent,
      &existing_remote_store_index);

  if (err) {
    SetHandleStep(handle, "Failed to get existing content");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  struct Longtail_StoreIndex* remote_missing_store_index;
  err = Longtail_CreateMissingContent(
      hash_api,
      existing_remote_store_index,
      source_version_index,
      TargetBlockSize,
      MaxChunksPerBlock,
      &remote_missing_store_index);

  if (err) {
    SetHandleStep(handle, "Failed to create missing store index");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  progress = MakeProgressAPI("Writing blocks");
  if (progress) {
    err = Longtail_WriteContent(
        file_storage_api,
        store_block_store_api,
        job_api,
        progress,
        &cancel_api.m_API,
        cancel_token,
        remote_missing_store_index,
        source_version_index,
        LocalRootPath);
    SAFE_DISPOSE_API(progress);
    progress = 0;
  } else {
    err = ENOMEM;
  }

  if (err) {
    SetHandleStep(handle, "Failed to create store blocks");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  struct SyncFlush flushCB;
  err = SyncFlush_Init(&flushCB);
  if (err) {
    SetHandleStep(handle, "Failed create SyncFlush");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(&flushCB.m_API);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  err = Longtail_BlockStore_Flush(store_block_store_api, &flushCB.m_API);
  if (err) {
    SetHandleStep(handle, "Failed flush compression block store");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(&flushCB.m_API);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  } else {
    SyncFlush_Wait(&flushCB);
    if (flushCB.m_Err != 0) {
      SetHandleStep(handle, "Failed flush compression block store");
      handle->error = flushCB.m_Err;
      handle->completed = 1;
      Longtail_Free(existing_remote_store_index);
      Longtail_Free(source_version_index);
      SAFE_DISPOSE_API(&flushCB.m_API);
      SAFE_DISPOSE_API(chunker_api);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(store_block_fsstore_api);
      SAFE_DISPOSE_API(file_storage_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return flushCB.m_Err;
    }
  }

  err = SyncFlush_Init(&flushCB);
  if (err) {
    SetHandleStep(handle, "Failed create SyncFlush");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(&flushCB.m_API);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  err = Longtail_BlockStore_Flush(store_block_fsstore_api, &flushCB.m_API);
  if (err) {
    SetHandleStep(handle, "Failed flush fs block store");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(&flushCB.m_API);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  } else {
    SyncFlush_Wait(&flushCB);
    if (flushCB.m_Err != 0) {
      SetHandleStep(handle, "Failed flush fs block store");
      handle->error = flushCB.m_Err;
      handle->completed = 1;
      Longtail_Free(existing_remote_store_index);
      Longtail_Free(source_version_index);
      SAFE_DISPOSE_API(&flushCB.m_API);
      SAFE_DISPOSE_API(chunker_api);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(store_block_fsstore_api);
      SAFE_DISPOSE_API(file_storage_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return flushCB.m_Err;
    }
  }

  SeaweedFSStorageAPI* seaweed_actual_api = (SeaweedFSStorageAPI*)seaweed_storage_api;

  std::stringstream version_file_stream;
  void* missing_store_index_buffer = 0;
  size_t missing_store_index_size;
  if (seaweed_actual_api->m_NumAddedBlocks > 0) {
    version_file_stream << std::string("0x") << std::hex << source_version_index->m_Version << std::string(".lvi");

    std::stringstream version_index_stream;
    version_index_stream << std::string(RemoteBasePath) << std::string("/versions/") << version_file_stream.str();
    std::string target_version_index_path = version_index_stream.str().c_str();

    err = Longtail_WriteVersionIndex(
        seaweed_storage_api,
        source_version_index,
        target_version_index_path.c_str());

    if (err) {
      SetHandleStep(handle, "Failed to write version index");
      handle->error = err;
      handle->completed = 1;
      Longtail_Free(remote_missing_store_index);
      Longtail_Free(existing_remote_store_index);
      Longtail_Free(source_version_index);
      SAFE_DISPOSE_API(chunker_api);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(store_block_fsstore_api);
      SAFE_DISPOSE_API(file_storage_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return err;
    }

    err = Longtail_WriteStoreIndexToBuffer(remote_missing_store_index, &missing_store_index_buffer, &missing_store_index_size);

    if (err) {
      SetHandleStep(handle, "Failed to write missing store index to buffer");
      handle->error = err;
      handle->completed = 1;
      Longtail_Free(remote_missing_store_index);
      Longtail_Free(existing_remote_store_index);
      Longtail_Free(source_version_index);
      SAFE_DISPOSE_API(chunker_api);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(store_block_fsstore_api);
      SAFE_DISPOSE_API(file_storage_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return err;
    }
  }

  json payload = {
      {"apiToken", std::string(API_JWT)},
      {"branchName", std::string(BranchName)},
      {"message", std::string(Message)},
      {"modifications", json::array()},
      {"versionIndex", version_file_stream.str()}};

  for (uint32_t i = 0; i < NumModifications; ++i) {
    payload["modifications"].push_back(json::object());
    payload["modifications"][i]["delete"] = Modifications[i].IsDelete;
    payload["modifications"][i]["path"] = std::string(Modifications[i].Path);

    if (Modifications[i].OldPath != nullptr) {
      payload["modifications"][i]["oldPath"] = std::string(Modifications[i].OldPath);
    }
  }

  cpr::Multipart multipart = {
      {"payload", payload.dump()}};

  if (missing_store_index_buffer != 0) {
    multipart.parts.push_back({"storeIndex", cpr::Buffer{(char*)missing_store_index_buffer, (char*)missing_store_index_buffer + missing_store_index_size, "chunk.bin"}});
  }

  cpr::Response r = cpr::Post(
      cpr::Url{std::string(BackendUrl) + "/submit"},
      cpr::Bearer{std::string(JWT)},
      multipart);

  if (r.status_code != 200) {
    SetHandleStep(handle, "Failed to submit to backend");
    handle->error = r.status_code;
    handle->completed = 1;
    Longtail_Free(remote_missing_store_index);
    Longtail_Free(existing_remote_store_index);
    Longtail_Free(source_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(store_block_fsstore_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return r.status_code;
  }

  json result = {
      {"changeListNumber", std::string(BranchName)}};

  strcpy(handle->result, result.dump().c_str());

  SetHandleStep(handle, "Completed");
  handle->error = 0;
  handle->completed = 1;

  Longtail_Free(remote_missing_store_index);
  Longtail_Free(existing_remote_store_index);
  Longtail_Free(source_version_index);
  SAFE_DISPOSE_API(chunker_api);
  SAFE_DISPOSE_API(store_block_store_api);
  SAFE_DISPOSE_API(store_block_fsstore_api);
  SAFE_DISPOSE_API(file_storage_api);
  SAFE_DISPOSE_API(seaweed_storage_api);
  SAFE_DISPOSE_API(compression_registry);
  SAFE_DISPOSE_API(hash_registry);
  SAFE_DISPOSE_API(job_api);

  return 0;
}

DLL_EXPORT WrapperAsyncHandle*
SubmitAsync(
    const char* BranchName,
    const char* Message,
    uint32_t TargetChunkSize,
    uint32_t TargetBlockSize,
    uint32_t MaxChunksPerBlock,
    uint32_t MinBlockUsagePercent,
    const char* HashingAlgo,
    const char* CompressionAlgo,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* BackendUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    const char* API_JWT,
    uint32_t NumModifications,
    const Modification* Modifications,
    int LogLevel = 4) {
  SetLogging(LogLevel);

  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }

  memset(handle, 0, sizeof(WrapperAsyncHandle));

  SetHandleStep(handle, "Initializing");

  std::thread diff_thread([=]() {
    int32_t err = Submit(
        BranchName,
        Message,
        TargetChunkSize,
        TargetBlockSize,
        MaxChunksPerBlock,
        MinBlockUsagePercent,
        HashingAlgo,
        CompressionAlgo,
        EnableMmapIndexing,
        EnableMmapBlockStore,
        LocalRootPath,
        RemoteBasePath,
        FilerUrl,
        BackendUrl,
        JWT,
        JWTExpirationMs,
        API_JWT,
        NumModifications,
        Modifications,
        handle);

    if (err) {
      std::cerr << "Failed to commit, " << err << ": " << handle->currentStep << std::endl;
    }
  });

  diff_thread.detach();

  return handle;
}
