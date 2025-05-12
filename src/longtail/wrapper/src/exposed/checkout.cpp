#include <filesystem>
#include <fstream>
#include <string>

#include "../util/config.h"
#include "../util/diff.h"
#include "../util/graphql-client.h"
#include "main.h"

namespace fs = std::filesystem;

Checkpoint::ErrorResult* Checkpoint::Checkout(
    Workspace* workspace,
    size_t numFiles,
    const char* paths,
    bool* isLocked) {
  Checkpoint::ErrorResult* result = new Checkpoint::ErrorResult();

  if (
      workspace == nullptr ||
      workspace->localRoot == nullptr ||
      strlen(workspace->localRoot) == 0 ||
      !fs::exists(fs::path(workspace->localRoot))) {
    std::string error = "Invalid workspace details";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  if (numFiles == 0 || paths == nullptr || isLocked == nullptr) {
    std::string error = "Invalid paths";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::vector<std::pair<std::string, bool>> files;

  uint32_t pathIdx = 0;
  for (size_t i = 0; i < numFiles; ++i) {
    size_t pathLength = strlen(paths + pathIdx);

    if (pathLength == 0) {
      std::string error = "Invalid path length for file at index " + std::to_string(i);
      result->success = false;
      result->error = new char[error.length() + 1];
      strcpy(result->error, error.c_str());
      return result;
    }

    files.push_back({std::string(strdup(paths + pathIdx)),
                     isLocked[i]});
    pathIdx += pathLength + 1;
  }

  result->success = true;
  return result;
}
