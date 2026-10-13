#pragma once

// Upload failure tracking and retry for the object storage adapters (gateway
// and S3).
//
// Both adapters buffer writes and send one PUT from CloseFile, and
// Longtail_StorageAPI::CloseFile returns void. Longtail therefore cannot learn
// that a block or a version index never reached the store: Longtail_WriteContent
// and Longtail_WriteVersionIndex report success either way. Left alone, a
// network blip during a submit produces a changelist whose data does not exist.
//
// So each adapter keeps a sticky record of the uploads that failed for good,
// and every caller that writes through an adapter has to check it before
// treating the write as done (see SubmitSync and Merge).

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

#include "../exposed/wrapper-handle.h"

struct UploadFailures {
  std::atomic<uint32_t> m_Count{0};
  std::mutex m_Mutex;
  std::string m_FirstPath;
  std::string m_FirstReason;

  void Record(const char* path, const std::string& reason) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    if (m_Count.fetch_add(1) == 0) {
      m_FirstPath = path ? path : "";
      m_FirstReason = reason;
    }
  }

  bool Any() const { return m_Count.load() != 0; }

  // One line naming the first failure, short enough for a handle step.
  std::string Describe() {
    std::lock_guard<std::mutex> lock(m_Mutex);
    uint32_t count = m_Count.load();
    std::string message = "Upload failed: " + m_FirstPath + " (" + m_FirstReason + ")";
    if (count > 1) {
      message += " and " + std::to_string(count - 1) + " more";
    }
    return message;
  }
};

// Transport failures (status 0), timeouts, throttling, and server errors are
// worth another attempt. Any other 4xx is the server telling us the request
// itself is wrong (bad token, path outside the repo), which a retry cannot fix.
static inline bool IsRetryableUploadStatus(long status_code) {
  return status_code == 0 || status_code == 408 || status_code == 429 || status_code >= 500;
}

static inline std::string DescribeUploadResult(long status_code, const std::string& curl_error) {
  if (status_code == 0) {
    return curl_error.empty() ? std::string("no response") : curl_error;
  }
  return "HTTP " + std::to_string(status_code);
}

static const uint32_t UPLOAD_MAX_ATTEMPTS = 4;

// Runs `put` (anything returning a response with status_code and error) until
// it succeeds, fails in a way a retry cannot fix, runs out of attempts, or the
// operation is canceled. Returns the last response.
template <typename PutFn>
static inline auto UploadWithRetry(WrapperAsyncHandle* handle, PutFn put) -> decltype(put()) {
  static const uint32_t backoff_ms[UPLOAD_MAX_ATTEMPTS - 1] = {500, 2000, 5000};

  auto response = put();
  for (uint32_t attempt = 1; attempt < UPLOAD_MAX_ATTEMPTS; ++attempt) {
    if (response.status_code >= 200 && response.status_code < 300) {
      break;
    }
    if (!IsRetryableUploadStatus(response.status_code)) {
      break;
    }
    // Sleep in slices so a cancel does not have to wait out the backoff.
    uint32_t waited_ms = 0;
    while (waited_ms < backoff_ms[attempt - 1]) {
      if (handle && handle->canceled) {
        return response;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      waited_ms += 50;
    }
    response = put();
  }
  return response;
}
