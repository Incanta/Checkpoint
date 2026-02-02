#pragma once

#include <string>

#include "types.h"

#ifdef _WIN32
#define DLL_EXPORT extern "C" __declspec(dllexport)
#else
#define DLL_EXPORT extern "C"
#endif

#define NO_BLOCKS_ERROR 10100
