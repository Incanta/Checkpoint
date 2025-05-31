#include <filesystem>
#include <fstream>
#include <string>

#include "../util/config.h"
#include "../util/diff.h"
#include "../util/graphql-client.h"
#include "main.h"

namespace fs = std::filesystem;

Checkpoint::ErrorResult* Checkpoint::Stage(
    Checkpoint::Workspace* workspace,
    size_t numFiles,
    const char* paths,
    bool isStaged) {
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

  if (numFiles == 0 || paths == nullptr) {
    std::string error = "Invalid paths";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::vector<std::string> filePaths;

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

    filePaths.push_back(std::string(strdup(paths + pathIdx)));
    pathIdx += pathLength + 1;
  }

  for (const auto& filePath : filePaths) {
    if (!fs::exists(fs::path(filePath))) {
      std::string error = "File does not exist: " + filePath;
      result->success = false;
      result->error = new char[error.length() + 1];
      strcpy(result->error, error.c_str());
      return result;
    }
  }

  for (const auto& filePath : filePaths) {
    CheckpointConfig::StageFile(workspace, isStaged, filePath);
  }

  result->success = true;
  return result;
}
