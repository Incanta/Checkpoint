#pragma once

#include <cstdint>
#include <string>

namespace Checkpoint {

struct Modification {
  bool IsDelete;
  const char* Path;
  const char* OldPath;
};

}  // namespace Checkpoint
