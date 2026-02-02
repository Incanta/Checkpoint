#pragma once

#ifdef _WIN32
#include <windows.h>
#endif

#include <bikeshed/longtail_bikeshed.h>
#include <blake2/longtail_blake2.h>
#include <blake3/longtail_blake3.h>
#include <brotli/longtail_brotli.h>
#include <compressblockstore/longtail_compressblockstore.h>
#include <compressionregistry/longtail_full_compression_registry.h>
#include <curl/curl.h>
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
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <thread>

#include "../util/json.h"
#include "../util/seaweedfs.h"
#include "exposed.h"

struct WrapperAsyncHandle {
  char currentStep[256];
  uint32_t changingStep;
  uint32_t canceled;
  uint32_t completed;
  int32_t error;
  char result[2048];
};

void SetHandleStep(WrapperAsyncHandle* handle, const char* step);
bool IsHandleCanceled(WrapperAsyncHandle* handle);

uint32_t ParseCompressionType(const char* compression_algorithm);
uint32_t ParseHashingType(const char* hashing_type);

void SetLogging(int level);

int32_t SubmitSync(
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
    bool KeepCheckedOut,
    const char* WorkspaceId,
    uint32_t NumModifications,
    const Checkpoint::Modification* Modifications,
    WrapperAsyncHandle* handle);

int32_t PullSync(
    const char* VersionIndex,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    WrapperAsyncHandle* handle);
