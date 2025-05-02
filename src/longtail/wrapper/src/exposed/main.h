#pragma once

#include <bikeshed/longtail_bikeshed.h>
#include <blake2/longtail_blake2.h>
#include <blake3/longtail_blake3.h>
#include <brotli/longtail_brotli.h>
#include <compressblockstore/longtail_compressblockstore.h>
#include <compressionregistry/longtail_full_compression_registry.h>
#include <cpr/cpr.h>
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

#include "../util/json.hpp"
#include "../util/seaweedfs.h"

#ifdef _WIN32
#define DLL_EXPORT extern "C" __declspec(dllexport)
#else
#define DLL_EXPORT extern "C"
#endif

#define NO_BLOCKS_ERROR 10100

struct WrapperAsyncHandle {
  char currentStep[256];
  uint32_t changingStep;
  uint32_t canceled;
  uint32_t completed;
  int32_t error;
  char result[2048];
};

using json = nlohmann::json;

struct Modification {
  bool IsDelete;
  const char* Path;
  const char* OldPath;
};

void SetHandleStep(WrapperAsyncHandle* handle, const char* step);
bool IsHandleCanceled(WrapperAsyncHandle* handle);

uint32_t ParseCompressionType(const char* compression_algorithm);
uint32_t ParseHashingType(const char* hashing_type);

void SetLogging(int level);
