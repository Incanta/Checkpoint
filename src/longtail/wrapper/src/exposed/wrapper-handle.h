#pragma once

#include <cstdint>

// Shared async handle between C++ worker threads and the JS polling thread.
// Fields are read/written from multiple threads — use volatile for flags.
struct WrapperAsyncHandle {
  char currentStep[256];
  uint32_t changingStep;
  uint32_t canceled;
  uint32_t completed;
  int32_t error;
  char result[2048];
  uint32_t progressTotal;
  uint32_t progressDone;

  // ---- Token refresh protocol ----
  // C++ worker thread sets needsTokenRefresh=1 when storage credentials are
  // approaching expiry. JS polling thread detects this, fetches fresh
  // credentials, writes them to the refreshed* fields, and sets
  // tokenRefreshCompleted=1. C++ reads the new values and clears all flags.
  volatile uint32_t needsTokenRefresh;
  volatile uint32_t tokenRefreshCompleted;
  volatile uint32_t tokenRefreshInProgress;
  uint64_t tokenExpirationMs;

  // JS writes refreshed credentials here
  char refreshedJwt[4096];
  char refreshedR2AccessKeyId[256];
  char refreshedR2SecretAccessKey[256];
  char refreshedR2SessionToken[2048];
  uint64_t refreshedExpirationMs;
};
