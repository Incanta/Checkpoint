#pragma once

#include <cstdint>

// Shared async handle between C++ worker threads and the JS polling thread.
// Fields are read/written from multiple threads: use volatile for flags.
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

  // JS writes refreshed credentials here. refreshedJwt is used by the gateway
  // adapter; the refreshedS3* fields by the S3 adapter (R2 / generic S3).
  char refreshedJwt[4096];
  char refreshedS3AccessKeyId[256];
  char refreshedS3SecretAccessKey[256];
  char refreshedS3SessionToken[2048];
  uint64_t refreshedExpirationMs;

  // Set by the worker once the outcome (error, currentStep, result) is final,
  // while it may still be tearing down the APIs it built. Internal to the
  // wrapper: nothing outside the worker reads it.
  //
  // `completed` above is different, and is the only thing a poller may act on.
  // The poller frees this handle as soon as it sees `completed`, and the
  // storage adapters and job threads keep a pointer to it until they are
  // disposed, so `completed` is set exactly once, by the thread lambda in each
  // *Async function, as the last thing the worker ever does with the handle.
  // Setting it any earlier is a use-after-free.
  uint32_t settled;
};
