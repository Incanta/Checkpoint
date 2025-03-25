#include "main.h"

#include <bikeshed/longtail_bikeshed.h>
#include <blake2/longtail_blake2.h>
#include <blake3/longtail_blake3.h>
#include <brotli/longtail_brotli.h>
#include <compressblockstore/longtail_compressblockstore.h>
#include <compressionregistry/longtail_full_compression_registry.h>
#include <filestorage/longtail_filestorage.h>
#include <fsblockstore/longtail_fsblockstore.h>
#include <hashregistry/longtail_full_hash_registry.h>
#include <hpcdcchunker/longtail_hpcdcchunker.h>
#include <longtail.h>
#include <longtail_platform.h>
#include <lz4/longtail_lz4.h>
#include <meowhash/longtail_meowhash.h>
#include <ratelimitedprogress/longtail_ratelimitedprogress.h>
#include <zstd/longtail_zstd.h>

#include <chrono>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <thread>

#include "seaweedfs.h"

struct Modification {
  bool IsDelete;
  const char* Path;
};

uint32_t ParseCompressionType(const char* compression_algorithm) {
  if ((compression_algorithm == 0) || (strcmp("none", compression_algorithm) == 0)) {
    return 0;
  }
  if (strcmp("brotli", compression_algorithm) == 0) {
    return Longtail_GetBrotliGenericDefaultQuality();
  }
  if (strcmp("brotli_min", compression_algorithm) == 0) {
    return Longtail_GetBrotliGenericMinQuality();
  }
  if (strcmp("brotli_max", compression_algorithm) == 0) {
    return Longtail_GetBrotliGenericMaxQuality();
  }
  if (strcmp("brotli_text", compression_algorithm) == 0) {
    return Longtail_GetBrotliTextDefaultQuality();
  }
  if (strcmp("brotli_text_min", compression_algorithm) == 0) {
    return Longtail_GetBrotliTextMinQuality();
  }
  if (strcmp("brotli_text_max", compression_algorithm) == 0) {
    return Longtail_GetBrotliTextMaxQuality();
  }
  if (strcmp("lz4", compression_algorithm) == 0) {
    return Longtail_GetLZ4DefaultQuality();
  }
  if (strcmp("zstd", compression_algorithm) == 0) {
    return Longtail_GetZStdDefaultQuality();
  }
  if (strcmp("zstd_min", compression_algorithm) == 0) {
    return Longtail_GetZStdMinQuality();
  }
  if (strcmp("zstd_max", compression_algorithm) == 0) {
    return Longtail_GetZStdMaxQuality();
  }
  if (strcmp("zstd_high", compression_algorithm) == 0) {
    return Longtail_GetZStdHighQuality();
  }
  if (strcmp("zstd_low", compression_algorithm) == 0) {
    return Longtail_GetZStdLowQuality();
  }
  return 0xffffffff;
}

uint32_t ParseHashingType(const char* hashing_type) {
  if (0 == hashing_type || (strcmp("blake3", hashing_type) == 0)) {
    return Longtail_GetBlake3HashType();
  }
  if (strcmp("blake2", hashing_type) == 0) {
    return Longtail_GetBlake2HashType();
  }
  if (strcmp("meow", hashing_type) == 0) {
    return Longtail_GetMeowHashType();
  }
  return 0xffffffff;
}

struct Progress {
  struct Longtail_ProgressAPI m_API;
  struct Longtail_ProgressAPI* m_RateLimitedProgressAPI;
  const char* m_Task;
  uint32_t m_UpdateCount;
};

static void Progress_OnProgress(
    struct Longtail_ProgressAPI* progress_api,
    uint32_t total,
    uint32_t jobs_done) {
  struct Progress* p = (struct Progress*)progress_api;
  if (jobs_done < total) {
    if (!p->m_UpdateCount) {
      fprintf(stderr, "%s: ", p->m_Task);
    }

    uint32_t percent_done = (100 * jobs_done) / total;
    fprintf(stderr, "%u%% ", percent_done);
    ++p->m_UpdateCount;
    return;
  }

  if (p->m_UpdateCount) {
    fprintf(stderr, "100%%");
  }
}

static void Progress_Dispose(struct Longtail_API* api) {
  struct Progress* me = (struct Progress*)api;
  if (me->m_UpdateCount) {
    fprintf(stderr, " Done\n");
  }
  Longtail_Free(me);
}

struct Longtail_ProgressAPI* MakeProgressAPI(const char* task) {
  void* mem = Longtail_Alloc(0, sizeof(struct Progress));

  if (!mem) {
    return 0;
  }

  struct Longtail_ProgressAPI* progress_api = Longtail_MakeProgressAPI(
      mem,
      Progress_Dispose,
      Progress_OnProgress);

  if (!progress_api) {
    Longtail_Free(mem);
    return 0;
  }

  struct Progress* me = (struct Progress*)progress_api;
  me->m_RateLimitedProgressAPI = Longtail_CreateRateLimitedProgress(progress_api, 5);
  me->m_Task = task;
  me->m_UpdateCount = 0;
  return me->m_RateLimitedProgressAPI;
}

struct CheckpointCancelAPI {
  struct Longtail_CancelAPI m_API;
  struct WrapperAsyncHandle* m_Handle;
  CheckpointCancelAPI(struct WrapperAsyncHandle* handle)
      : m_Handle(handle) {
    Longtail_MakeCancelAPI(this,
                           Dispose,
                           CreateToken,
                           Cancel,
                           IsCancelled,
                           DisposeToken);
  }
  static void Dispose(struct Longtail_API* longtail_api) {
    struct CheckpointCancelAPI* api = (struct CheckpointCancelAPI*)longtail_api;
  }
  static int CreateToken(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken* out_token) {
    return 0;
  }
  static int Cancel(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken token) {
    struct CheckpointCancelAPI* api = (struct CheckpointCancelAPI*)cancel_api;
    api->m_Handle->canceled = 1;
    return 0;
  }
  static int IsCancelled(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken token) {
    struct CheckpointCancelAPI* api = (struct CheckpointCancelAPI*)cancel_api;
    return api->m_Handle->canceled ? 1 : 0;
  }
  static int DisposeToken(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken token) {
    return 0;
  }
};

struct AsyncGetExistingContentComplete {
  struct Longtail_AsyncGetExistingContentAPI m_API;
  HLongtail_Sema m_NotifySema;
  int m_Err;
  struct Longtail_StoreIndex* m_StoreIndex;
};

static void AsyncGetExistingContentComplete_OnComplete(struct Longtail_AsyncGetExistingContentAPI* async_complete_api, struct Longtail_StoreIndex* store_index, int err) {
  struct AsyncGetExistingContentComplete* cb = (struct AsyncGetExistingContentComplete*)async_complete_api;
  cb->m_Err = err;
  cb->m_StoreIndex = store_index;
  Longtail_PostSema(cb->m_NotifySema, 1);
}

void AsyncGetExistingContentComplete_Wait(struct AsyncGetExistingContentComplete* api) {
  Longtail_WaitSema(api->m_NotifySema, LONGTAIL_TIMEOUT_INFINITE);
}

static void AsyncGetExistingContentComplete_Init(struct AsyncGetExistingContentComplete* api) {
  api->m_Err = EINVAL;
  api->m_API.m_API.Dispose = 0;
  api->m_API.OnComplete = AsyncGetExistingContentComplete_OnComplete;
  api->m_StoreIndex = 0;
  Longtail_CreateSema(Longtail_Alloc(0, Longtail_GetSemaSize()), 0, &api->m_NotifySema);
}

static void AsyncGetExistingContentComplete_Dispose(struct AsyncGetExistingContentComplete* api) {
  Longtail_DeleteSema(api->m_NotifySema);
  Longtail_Free(api->m_NotifySema);
}

static int SyncGetExistingContent(struct Longtail_BlockStoreAPI* block_store, uint32_t chunk_count, const TLongtail_Hash* chunk_hashes, uint32_t min_block_usage_percent, struct Longtail_StoreIndex** out_store_index) {
  struct AsyncGetExistingContentComplete retarget_store_index_complete;
  AsyncGetExistingContentComplete_Init(&retarget_store_index_complete);
  int err = block_store->GetExistingContent(block_store, chunk_count, chunk_hashes, min_block_usage_percent, &retarget_store_index_complete.m_API);
  if (err) {
    return err;
  }
  AsyncGetExistingContentComplete_Wait(&retarget_store_index_complete);
  err = retarget_store_index_complete.m_Err;
  struct Longtail_StoreIndex* store_index = retarget_store_index_complete.m_StoreIndex;
  AsyncGetExistingContentComplete_Dispose(&retarget_store_index_complete);
  if (err) {
    return err;
  }
  *out_store_index = store_index;
  return 0;
}

struct SyncFlush {
  struct Longtail_AsyncFlushAPI m_API;
  HLongtail_Sema m_NotifySema;
  int m_Err;
};

void SyncFlush_OnComplete(struct Longtail_AsyncFlushAPI* async_complete_api, int err) {
  struct SyncFlush* api = (struct SyncFlush*)async_complete_api;
  api->m_Err = err;
  Longtail_PostSema(api->m_NotifySema, 1);
}

void SyncFlush_Wait(struct SyncFlush* sync_flush) {
  Longtail_WaitSema(sync_flush->m_NotifySema, LONGTAIL_TIMEOUT_INFINITE);
}

void SyncFlush_Dispose(struct Longtail_API* longtail_api) {
  struct SyncFlush* api = (struct SyncFlush*)longtail_api;
  Longtail_DeleteSema(api->m_NotifySema);
  Longtail_Free(api->m_NotifySema);
}

int SyncFlush_Init(struct SyncFlush* sync_flush) {
  sync_flush->m_Err = EINVAL;
  sync_flush->m_API.m_API.Dispose = SyncFlush_Dispose;
  sync_flush->m_API.OnComplete = SyncFlush_OnComplete;
  return Longtail_CreateSema(Longtail_Alloc(0, Longtail_GetSemaSize()), 0, &sync_flush->m_NotifySema);
}

void SetHandleStep(WrapperAsyncHandle* handle, const char* step) {
  std::cout << "SetHandleStep: " << step << std::endl;
  if (handle->changingStep) {
    return;
  }
  handle->changingStep = 1;
  memset(handle->currentStep, 0, sizeof(handle->currentStep));
  strcpy(handle->currentStep, step);
  handle->changingStep = 0;
}

bool IsHandleCanceled(WrapperAsyncHandle* handle) {
  if (handle->completed) {
    return false;
  }

  if (handle->canceled) {
    SetHandleStep(handle, "Canceled");
    handle->completed = 1;
    handle->error = ECANCELED;
    return true;
  }

  return false;
}

DLL_EXPORT void FreeHandle(WrapperAsyncHandle* handle) {
  Longtail_Free(handle);
}

int32_t Commit(
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
    const char* JWT,
    uint64_t JWTExpirationMs,
    uint32_t NumModifications,
    const Modification* Modifications, WrapperAsyncHandle* handle) {
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

    uint32_t length = (uint32_t)strlen(Modifications[i].Path) + 1;

    HLongtail_OpenFile file_handle;
    char* filePath = Longtail_ConcatPath(LocalRootPath, Modifications[i].Path);
    Longtail_OpenReadFile(filePath, &file_handle);
    Longtail_GetFileSize(file_handle, &file_infos->m_Sizes[i]);
    Longtail_CloseFile(file_handle);
    Longtail_Free(filePath);

    file_infos->m_Permissions[i] = 0644;  // should never be a directory
    file_infos->m_PathStartOffsets[i] = offset;
    memmove(&file_infos->m_PathData[offset], Modifications[i].Path, length);
    offset += length;
  }
  file_infos->m_PathDataSize = offset;
  file_infos->m_Count = NumModifications;

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

  if (seaweed_actual_api->m_NumAddedBlocks == 0) {
    err = NO_BLOCKS_ERROR;
    SetHandleStep(handle, "No blocks added");
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

  std::stringstream version_file_stream;
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
CommitAsync(
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
    const char* JWT,
    uint64_t JWTExpirationMs,
    uint32_t NumModifications,
    const Modification* Modifications) {
  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }

  memset(handle, 0, sizeof(WrapperAsyncHandle));

  SetHandleStep(handle, "Initializing");

  std::thread diff_thread([=]() {
    int32_t err = Commit(
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
        JWT,
        JWTExpirationMs,
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
