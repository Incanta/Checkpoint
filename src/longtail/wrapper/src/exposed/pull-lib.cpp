#include <filesystem>
#include <string>

#include "../util/config.h"
#include "../util/diff.h"
#include "../util/trpc-client.h"
#include "main.h"

namespace fs = std::filesystem;

Checkpoint::ErrorResult* Checkpoint::Pull(
    Checkpoint::Workspace* workspace,
    const char* changelistId) {
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

  std::string storageTokenQuery = R"EOF(
    query getStorageToken(
      $orgId: String!
      $repoId: String!
      $write: Boolean!
    ) {
      storageToken(orgId: $orgId, repoId: $repoId, write: $write) {
        token
        expiration
        backendUrl
      }
    }
  )EOF";

  json storageTokenVariables;
  storageTokenVariables["orgId"] = workspace->orgId;
  storageTokenVariables["repoId"] = workspace->repoId;
  storageTokenVariables["write"] = true;

  json storageTokenResult = GraphQLClient::Request(workspace->serverId, storageTokenQuery, storageTokenVariables);

  if (storageTokenResult.contains("error")) {
    std::string error = storageTokenResult["error"];
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  if (!storageTokenResult.contains("data") || !storageTokenResult["data"].contains("storageToken")) {
    std::string error = "Invalid response format";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::string storageToken = storageTokenResult["data"]["storageToken"]["token"];
  uint32_t tokenExpiration = storageTokenResult["data"]["storageToken"]["expiration"];
  std::string backendUrl = storageTokenResult["data"]["storageToken"]["backendUrl"];

  std::string remoteBasePath = "/" + std::string(workspace->orgId) + "/" + std::string(workspace->repoId);

  cpr::Response filerUrlResponse = cpr::Get(
      cpr::Url{backendUrl + "/filer-url"});

  if (filerUrlResponse.status_code != 200) {
    std::string error = "Failed to get filer URL";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }
  std::string filerUrl = filerUrlResponse.text;
  if (filerUrl.empty()) {
    std::string error = "Filer URL is empty";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::string changelistQuery = R"EOF(
    query getChangelist($id: String!) {
      changelist(id: $id) {
        number
        versionIndex
        stateTree
      }
    }
  )EOF";

  json changelistVariables;
  changelistVariables["id"] = changelistId;

  json changelistResult = GraphQLClient::Request(workspace->serverId, changelistQuery, changelistVariables);

  if (changelistResult.contains("error")) {
    std::string error = changelistResult["error"];
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  if (!changelistResult.contains("data") || !changelistResult["data"].contains("changelist")) {
    std::string error = "Invalid response format";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  WorkspaceStateResult* state = GetWorkspaceState(workspace);
  if (!state->success) {
    std::string error = "Failed to get workspace state";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }
  json stateData = json::parse(state->state->filesJson);

  WorkspaceStateDiff diff = GetWorkspaceStateDiff(stateData["files"], changelistResult["data"]["changelist"]["stateTree"]);

  std::string changelistsQuery = R"EOF(
    query getChangelists($repoId: String!, $numbers: [Int!]!) {
      changelists(repoId: $repoId, numbers: $numbers) {
        id
        number
        versionIndex
      }
    }
  )EOF";

  json changelistsVariables;
  changelistsVariables["repoId"] = workspace->repoId;
  changelistsVariables["numbers"] = json::array();
  for (const auto& changelist : diff.changelistsToPull) {
    changelistsVariables["numbers"].push_back(changelist);
  }

  json changelistsResult = GraphQLClient::Request(workspace->serverId, changelistsQuery, changelistsVariables);
  if (changelistsResult.contains("error")) {
    std::string error = changelistsResult["error"];
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  if (!changelistsResult.contains("data") || !changelistsResult["data"].contains("changelists")) {
    std::string error = "Invalid response format";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::vector<std::pair<int, std::string>> sortedChangelists;
  std::vector<std::string> versionsToPull;

  for (const auto& changelist : changelistsResult["data"]["changelists"]) {
    sortedChangelists.push_back({changelist["number"], changelist["versionIndex"]});
  }

  std::sort(sortedChangelists.begin(), sortedChangelists.end(),
            [](const auto& a, const auto& b) {
              return a.first < b.first;
            });

  for (const auto& changelist : sortedChangelists) {
    versionsToPull.push_back(changelist.second);
  }

  int32_t lastError = false;
  std::string lastStep;
  for (const auto& version : versionsToPull) {
    if (version.empty()) {
      continue;
    }

    WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
    if (!handle) {
      std::string error = "Failed to allocate memory for handle";
      result->success = false;
      result->error = new char[error.length() + 1];
      strcpy(result->error, error.c_str());
      return result;
    }

    memset(handle, 0, sizeof(WrapperAsyncHandle));

    lastError = PullSync(
        version.c_str(),
        false,  // EnableMmapIndexing
        false,  // EnableMmapBlockStore
        workspace->localRoot,
        remoteBasePath.c_str(),
        filerUrl.c_str(),
        storageToken.c_str(),
        tokenExpiration * 1000,
        handle);

    lastStep.assign(strdup(handle->currentStep));

    Longtail_Free(handle);

    if (lastError != 0) {
      break;
    }
  }

  if (lastError != 0) {
    std::string error = "Pull failed with error code: " + std::to_string(lastError) + ", message: " + lastStep;
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::string filesQuery = R"EOF(
    query files($ids: [String!]!) {
      files(ids: $ids) {
        id
        path
      }
    }
  )EOF";

  json filesVariables;
  filesVariables["ids"] = json::array();
  for (const auto& deletion : diff.deletions) {
    filesVariables["ids"].push_back(deletion);
  }

  json filesResult = GraphQLClient::Request(workspace->serverId, filesQuery, filesVariables);
  if (filesResult.contains("error")) {
    std::string error = filesResult["error"];
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  if (!filesResult.contains("data") || !filesResult["data"].contains("files")) {
    std::string error = "Invalid response format";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  for (const auto& file : filesResult["data"]["files"]) {
    if (file["path"].is_string()) {
      fs::path filePath = fs::path(workspace->localRoot) / file["path"].get<std::string>();
      if (fs::exists(filePath)) {
        fs::remove(filePath);
      }
    }
  }

  result->success = true;
  return result;
}
