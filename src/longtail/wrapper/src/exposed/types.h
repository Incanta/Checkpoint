#pragma once

#include <string>

namespace Checkpoint {

struct WhoamiResult {
  bool success;
  char* id = nullptr;
  char* email = nullptr;
  char* error = nullptr;
};

struct ErrorResult {
  bool success;
  char* error = nullptr;
};

struct WorkspaceConfig {
  char* orgId = nullptr;
  char* repoId = nullptr;
  char* branchName = nullptr;
  char* workspaceName = nullptr;
};

struct Workspace : public WorkspaceConfig {
  char* localRoot = nullptr;
};

struct WorkspaceState {
  uint32_t changelistNumber = 0;
  char* filesJson = nullptr;
};

struct WorkspaceResult {
  bool success;
  char* error = nullptr;
  Workspace* workspace = nullptr;
};

struct WorkspaceStateResult {
  bool success;
  char* error = nullptr;
  WorkspaceState* state = nullptr;
};

struct Modification {
  bool IsDelete;
  const char* Path;
  const char* OldPath;
};

}  // namespace Checkpoint
