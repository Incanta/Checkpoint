#pragma once

// Token refresh helper for storage APIs.
// Both R2 and SeaweedFS storage implementations include this to
// proactively refresh credentials before they expire.

#include "../exposed/wrapper-handle.h"

#include <chrono>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#define TOKEN_CAS32(ptr, expected, desired) \
  (InterlockedCompareExchange((volatile LONG*)(ptr), (LONG)(desired), (LONG)(expected)) == (LONG)(expected))
#else
#define TOKEN_CAS32(ptr, expected, desired) \
  __sync_bool_compare_and_swap(ptr, expected, desired)
#endif

#ifndef ECANCELED
#define ECANCELED 125
#endif

#ifndef ETIMEDOUT
#define ETIMEDOUT 110
#endif

// Check if the token is close to expiry and request a refresh from the
// JS polling thread if needed. Returns 0 on success, ECANCELED if the
// operation was canceled, ETIMEDOUT if the JS side didn't respond.
//
// Thread-safe: uses CAS on tokenRefreshInProgress so that only one
// worker thread triggers the refresh; others block until it completes.
static inline int EnsureTokenFresh(WrapperAsyncHandle* handle) {
  if (!handle || handle->tokenExpirationMs == 0) return 0;

  auto now = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();

  // Refresh when within 5 minutes of expiration
  if (now + 300000ULL < handle->tokenExpirationMs) return 0;

  // Try to be the one thread that triggers the refresh
  if (!TOKEN_CAS32(&handle->tokenRefreshInProgress, 0, 1)) {
    // Another thread is already handling refresh — just wait
    while (handle->tokenRefreshInProgress) {
      if (handle->canceled) return ECANCELED;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return 0;
  }

  // Signal the JS polling thread
  handle->needsTokenRefresh = 1;

  // Wait for JS to provide new credentials (30s timeout)
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (!handle->tokenRefreshCompleted) {
    if (handle->canceled) {
      handle->tokenRefreshInProgress = 0;
      handle->needsTokenRefresh = 0;
      return ECANCELED;
    }
    if (std::chrono::steady_clock::now() > deadline) {
      handle->tokenRefreshInProgress = 0;
      handle->needsTokenRefresh = 0;
      return ETIMEDOUT;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  // Update expiration from the refreshed value
  handle->tokenExpirationMs = handle->refreshedExpirationMs;

  // Clear flags — ready for the next refresh cycle
  handle->needsTokenRefresh = 0;
  handle->tokenRefreshCompleted = 0;
  handle->tokenRefreshInProgress = 0;

  return 0;
}
