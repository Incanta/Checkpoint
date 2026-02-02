#include "main.h"

#include <curl/curl.h>

// Global curl initialization - must be called before any HTTP requests
// This handles thread-safety initialization for multi-threaded environments
#ifdef _WIN32
// Windows: Use DllMain for initialization
BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
  switch (ul_reason_for_call) {
    case DLL_PROCESS_ATTACH:
      curl_global_init(CURL_GLOBAL_ALL);
      break;
    case DLL_PROCESS_DETACH:
      curl_global_cleanup();
      break;
  }
  return TRUE;
}
#else
// Unix: Use constructor/destructor attributes
__attribute__((constructor)) static void InitCurl() {
  curl_global_init(CURL_GLOBAL_ALL);
}

__attribute__((destructor)) static void CleanupCurl() {
  curl_global_cleanup();
}
#endif

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

void SetHandleStep(WrapperAsyncHandle* handle, const char* step) {
  LONGTAIL_LOG(0, LONGTAIL_LOG_LEVEL_DEBUG, "SetHandleStep: %s", step);
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

static const char* ERROR_LEVEL[5] = {"DEBUG", "INFO", "WARNING", "ERROR", "OFF"};

static int LogContext(struct Longtail_LogContext* log_context, char* buffer, int buffer_size) {
  if (log_context == 0 || log_context->field_count == 0) {
    return 0;
  }
  int len = sprintf(buffer, " { ");
  size_t log_field_count = log_context->field_count;
  for (size_t f = 0; f < log_field_count; ++f) {
    struct Longtail_LogField* log_field = &log_context->fields[f];
    len += snprintf(&buffer[len], buffer_size - len, "\"%s\": %s%s", log_field->name, log_field->value, ((f + 1) < log_field_count) ? ", " : "");
  }
  len += snprintf(&buffer[len], buffer_size - len, " }");
  return len;
}

static void LogStdErr(struct Longtail_LogContext* log_context, const char* log) {
  char buffer[2048];
  int len = snprintf(buffer, 2048, "%s(%d) [%s] %s", log_context->file, log_context->line, log_context->function, ERROR_LEVEL[log_context->level]);
  len += LogContext(log_context, &buffer[len], 2048 - len);
  snprintf(&buffer[len], 2048 - len, " : %s\n", log);
  fprintf(stderr, "%s", buffer);
}

void SetLogging(int level) {
  Longtail_SetLog(LogStdErr, 0);
  Longtail_SetLogLevel(level);
}
