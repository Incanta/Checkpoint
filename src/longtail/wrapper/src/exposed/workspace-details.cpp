#include <filesystem>
#include <fstream>
#include <string>

#include "main.h"

namespace fs = std::filesystem;

Checkpoint::WorkspaceResult* Checkpoint::GetWorkspaceDetails(const char* path) {
  Checkpoint::WorkspaceResult* result = new Checkpoint::WorkspaceResult();

  // find the .checkpoint directory in any parent directory
  fs::path currentPath(path);
  fs::path localRoot;
  if (fs::exists(currentPath / ".checkpoint")) {
    localRoot = currentPath;
  } else {
    while (currentPath.has_parent_path()) {
      if (fs::exists(currentPath / ".checkpoint")) {
        localRoot = currentPath;
        break;
      }
      currentPath = currentPath.parent_path();
    }
  }

  if (localRoot.empty()) {
    std::string error = "Could not find a Checkpoint workspace";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::ifstream configFile(localRoot / ".checkpoint" / "config.json");
  if (!configFile.is_open()) {
    std::string error = "Could not open config file";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }
  std::string contents((std::istreambuf_iterator<char>(configFile)), std::istreambuf_iterator<char>());
  configFile.close();

  json configData = json::parse(contents);

  if (configData.contains("serverId")) {
    result->workspace->serverId = new char[configData["serverId"].get<std::string>().length() + 1];
    strcpy(result->workspace->serverId, configData["serverId"].get<std::string>().c_str());
  }

  if (configData.contains("orgId")) {
    result->workspace->orgId = new char[configData["orgId"].get<std::string>().length() + 1];
    strcpy(result->workspace->orgId, configData["orgId"].get<std::string>().c_str());
  }

  if (configData.contains("repoId")) {
    result->workspace->repoId = new char[configData["repoId"].get<std::string>().length() + 1];
    strcpy(result->workspace->repoId, configData["repoId"].get<std::string>().c_str());
  }

  if (configData.contains("branchName")) {
    result->workspace->branchName = new char[configData["branchName"].get<std::string>().length() + 1];
    strcpy(result->workspace->branchName, configData["branchName"].get<std::string>().c_str());
  }

  if (configData.contains("workspaceName")) {
    result->workspace->workspaceName = new char[configData["workspaceName"].get<std::string>().length() + 1];
    strcpy(result->workspace->workspaceName, configData["workspaceName"].get<std::string>().c_str());
  }

  result->workspace->localRoot = new char[localRoot.string().length() + 1];
  strcpy(result->workspace->localRoot, localRoot.string().c_str());

  result->success = true;
  return result;
}

Checkpoint::ErrorResult* SaveWorkspaceDetails(Checkpoint::Workspace* workspace) {
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

  json configData;
  configData["serverId"] = workspace->serverId;
  configData["orgId"] = workspace->orgId;
  configData["repoId"] = workspace->repoId;
  configData["branchName"] = workspace->branchName;
  configData["workspaceName"] = workspace->workspaceName;

  std::ofstream configFile(fs::path(workspace->localRoot) / ".checkpoint" / "config.json");
  if (!configFile.is_open()) {
    std::string error = "Could not open config file for writing";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }
  configFile << configData.dump(2);
  configFile.close();

  result->success = true;
  return result;
}

void Checkpoint::FreeWorkspace(Checkpoint::WorkspaceResult* result) {
  if (result->error != nullptr) {
    delete[] result->error;
  }
  if (result->workspace != nullptr) {
    if (result->workspace->serverId != nullptr) {
      delete[] result->workspace->serverId;
    }
    if (result->workspace->orgId != nullptr) {
      delete[] result->workspace->orgId;
    }
    if (result->workspace->repoId != nullptr) {
      delete[] result->workspace->repoId;
    }
    if (result->workspace->branchName != nullptr) {
      delete[] result->workspace->branchName;
    }
    if (result->workspace->workspaceName != nullptr) {
      delete[] result->workspace->workspaceName;
    }
    if (result->workspace->localRoot != nullptr) {
      delete[] result->workspace->localRoot;
    }
    delete result->workspace;
  }
  delete result;
}
