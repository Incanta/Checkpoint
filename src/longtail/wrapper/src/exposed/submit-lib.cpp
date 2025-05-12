#include <filesystem>
#include <string>

#include "../util/config.h"
#include "../util/graphql-client.h"
#include "main.h"

namespace fs = std::filesystem;

Checkpoint::ErrorResult* Checkpoint::Submit(
    Checkpoint::Workspace* workspace,
    const char* message,
    bool keepCheckedOut,
    const char* workspaceId,
    size_t numModifications,
    Checkpoint::Modification* modifications) {
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

  if (numModifications == 0 || modifications == nullptr) {
    std::string error = "Invalid modifications";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::string query = R"EOF(
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

  json variables;
  variables["orgId"] = workspace->orgId;
  variables["repoId"] = workspace->repoId;
  variables["write"] = true;

  json storageTokenResult = GraphQLClient::Request(query, variables);

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

  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }

  memset(handle, 0, sizeof(WrapperAsyncHandle));

  int32_t err = SubmitSync(
      workspace->branchName,
      message,
      32768,     // TargetChunkSize
      8388608,   // TargetBlockSize
      1024,      // MaxChunksPerBlock
      80,        // MinBlockUsagePercent
      "blake3",  // HashingAlgo
      "zstd",    // CompressionAlgo
      false,     // EnableMmapIndexing
      false,     // EnableMmapBlockStore
      workspace->localRoot,
      remoteBasePath.c_str(),
      filerUrl.c_str(),
      backendUrl.c_str(),
      storageToken.c_str(),
      tokenExpiration * 1000,
      CheckpointConfig::GetAuthToken().c_str(),
      keepCheckedOut,
      workspaceId,
      numModifications,
      modifications,
      handle);

  std::string lastStep(strdup(handle->currentStep));
  uint32_t changelistNumber = 0;

  if (err == 0) {
    json resultData = json::parse(handle->result);
    if (resultData.contains("changelistNumber")) {
      changelistNumber = resultData["changelistNumber"];
    }
  }

  Longtail_Free(handle);

  if (err != 0) {
    std::string error = "Submit failed with error code: " + std::to_string(err) + ", message: " + lastStep;
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  WorkspaceStateResult* state = GetWorkspaceState(workspace->localRoot);

  if (state->success) {
    json stateData = json::parse(state->state->filesJson);

    for (int i = 0; i < numModifications; i++) {
      if (modifications[i].IsDelete) {
        if (stateData.contains(modifications[i].Path)) {
          stateData.erase(modifications[i].Path);
        }
      } else {
        stateData[modifications[i].Path] = changelistNumber;
      }
    }
  }

  result->success = true;
  return result;
}
