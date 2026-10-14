#include "verify-blocks.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#endif

namespace verify_blocks {

// Replaces `target` with `source` in one step: anything reading `target` gets
// the old file or the new one, whole. Longtail's own rename refuses to replace
// an existing file on Windows, and its callers work around that by deleting
// the target first, which leaves a moment (or, after a crash, forever) with no
// file at all.
//
// The data is flushed to disk before the rename, so the name never points at
// a file whose contents are still only in a cache.
int ReplaceFileAtomically(const std::string& source, const std::string& target) {
#ifdef _WIN32
  auto widen = [](const std::string& utf8) {
    int length = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    std::wstring wide(length > 0 ? length : 1, L'\0');
    if (length > 0) {
      MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, &wide[0], length);
    }
    for (wchar_t& c : wide) {
      if (c == L'/') c = L'\\';
    }
    return wide;
  };
  std::wstring wide_source = widen(source);
  std::wstring wide_target = widen(target);

  HANDLE file = CreateFileW(wide_source.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return EIO;
  }
  BOOL flushed = FlushFileBuffers(file);
  CloseHandle(file);
  if (!flushed) {
    return EIO;
  }

  // A reader that holds the old index open without delete sharing makes the
  // replace fail for as long as it reads. That is brief, so wait it out.
  for (int attempt = 0; attempt < 50; ++attempt) {
    if (MoveFileExW(wide_source.c_str(), wide_target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      return 0;
    }
    DWORD error = GetLastError();
    if (error != ERROR_SHARING_VIOLATION && error != ERROR_ACCESS_DENIED && error != ERROR_LOCK_VIOLATION) {
      return EIO;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  return EBUSY;
#else
  int fd = open(source.c_str(), O_RDONLY);
  if (fd < 0) {
    return errno;
  }
  int sync_err = fsync(fd) == 0 ? 0 : errno;
  close(fd);
  if (sync_err) {
    return sync_err;
  }
  if (rename(source.c_str(), target.c_str()) != 0) {
    return errno;
  }
  // Make the rename itself durable. Not being able to is not a failed write.
  std::string dir = target.substr(0, target.find_last_of('/'));
  int dir_fd = open(dir.empty() ? "/" : dir.c_str(), O_RDONLY);
  if (dir_fd >= 0) {
    fsync(dir_fd);
    close(dir_fd);
  }
  return 0;
#endif
}

// Where FSBlockStore keeps a block, relative to the store root:
// chunks/<first 4 hex digits>/0x<16 hex digits>.lrb. This has to match
// GetBlockPath in longtail_fsblockstore.c (which is static, hence the copy)
// and the default extension Longtail_CreateFSBlockStoreAPI uses when SubmitSync
// passes none.
std::string BlockPath(const std::string& basePath, TLongtail_Hash block_hash) {
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
int VerifyBlocksExist(
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

}  // namespace verify_blocks
