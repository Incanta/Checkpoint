#pragma once

#include <cstdint>

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
};

void SetHandleStep(WrapperAsyncHandle* handle, const char* step);
