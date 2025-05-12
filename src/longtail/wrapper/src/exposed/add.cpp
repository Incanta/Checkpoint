#include <filesystem>
#include <fstream>
#include <string>

#include "../util/config.h"
#include "../util/diff.h"
#include "../util/graphql-client.h"
#include "main.h"

namespace fs = std::filesystem;

Checkpoint::ErrorResult* Checkpoint::Add(
    Checkpoint::Workspace* workspace,
    size_t numFiles,
    const char* paths) {
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

  // TODO need to check if the files are already in the workspace

  if (!Checkpoint::AcquireLock(workspace)) {
    std::string error = "Failed to acquire workspace lock";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  fs::path addFilePath = fs::path(workspace->localRoot) / ".checkpoint" / "add.json";
  std::ifstream addFile(addFilePath);

  if (!addFile.is_open()) {
    Checkpoint::ReleaseLock(workspace);
    std::string error = "Could not open add file";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::string contents((std::istreambuf_iterator<char>(addFile)), std::istreambuf_iterator<char>());
  addFile.close();
  json addData = json::parse(contents);

  for (const auto& filePath : filePaths) {
    if (addData.contains(filePath)) {
      continue;
    }

    addData[filePath] = true;
  }

  std::ofstream addFileOut(addFilePath);
  if (!addFileOut.is_open()) {
    Checkpoint::ReleaseLock(workspace);
    std::string error = "Could not open add file for writing";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }
  addFileOut << addData.dump(2);
  addFileOut.close();

  Checkpoint::ReleaseLock(workspace);
  result->success = true;
  return result;
}
