#include <filesystem>
#include <fstream>
#include <string>

#include "main.h"

namespace fs = std::filesystem;

Checkpoint::WorkspaceStateResult* Checkpoint::GetWorkspaceState(Checkpoint::Workspace* workspace) {
  Checkpoint::WorkspaceStateResult* result = new Checkpoint::WorkspaceStateResult();

  if (
      workspace == nullptr ||
      strlen(workspace->localRoot) == 0 ||
      !fs::exists(fs::path(workspace->localRoot))) {
    std::string error = "Invalid workspace local root";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::ifstream stateFile(fs::path(workspace->localRoot) / "state.json");
  if (!stateFile.is_open()) {
    result->state = new Checkpoint::WorkspaceState();
    result->state->changelistNumber = 0;
    result->state->filesJson = new char[3];
    strcpy(result->state->filesJson, "{}");
    result->success = true;
    return result;
  }
  std::string contents((std::istreambuf_iterator<char>(stateFile)), std::istreambuf_iterator<char>());
  stateFile.close();

  json stateData = json::parse(contents);

  result->state = new Checkpoint::WorkspaceState();
  result->state->changelistNumber = stateData.contains("changelistNumber") ? stateData["changelistNumber"].get<unsigned int>() : (unsigned int)0;

  if (stateData.contains("filesJson")) {
    std::string filesJson = stateData["filesJson"].dump();
    result->state->filesJson = new char[filesJson.length() + 1];
    strcpy(result->state->filesJson, filesJson.c_str());
  } else {
    result->state->filesJson = new char[3];
    strcpy(result->state->filesJson, "{}");
  }

  result->success = true;
  return result;
}

Checkpoint::ErrorResult* SaveWorkspaceState(Checkpoint::Workspace* workspace, Checkpoint::WorkspaceState* state) {
  Checkpoint::ErrorResult* result = new Checkpoint::ErrorResult();

  if (
      workspace == nullptr ||
      state == nullptr ||
      state->filesJson == nullptr ||
      strlen(state->filesJson) == 0 ||
      strlen(workspace->localRoot) == 0 ||
      !fs::exists(fs::path(workspace->localRoot))) {
    std::string error = "Invalid workspace state";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  fs::create_directories(fs::path(workspace->localRoot));

  std::ofstream stateFile(fs::path(workspace->localRoot) / "state.json");
  if (!stateFile.is_open()) {
    std::string error = "Failed to open state file for writing";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  json stateData;
  stateData["changelistNumber"] = state->changelistNumber;
  stateData["filesJson"] = json::parse(state->filesJson);

  stateFile << stateData.dump(2);
  stateFile.close();

  result->success = true;
  return result;
}

void Checkpoint::FreeWorkspaceState(Checkpoint::WorkspaceStateResult* result) {
  if (result->state != nullptr) {
    if (result->state->filesJson != nullptr) {
      delete[] result->state->filesJson;
    }
    delete result->state;
  }
  if (result->error != nullptr) {
    delete[] result->error;
  }
  delete result;
}
