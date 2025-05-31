
#include "../util/config.h"
#include "main.h"

Checkpoint::ErrorResult* Checkpoint::RefreshServerDetails(const char* serverBaseUrl) {
  Checkpoint::ErrorResult* result = new Checkpoint::ErrorResult();

  if (serverBaseUrl == nullptr || strlen(serverBaseUrl) == 0) {
    std::string error = "Invalid server base URL";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  // normalize the URL
  std::string normalizedUrl = serverBaseUrl;
  if (normalizedUrl.back() == '/') {
    normalizedUrl.pop_back();
  }
  if (normalizedUrl.find("http://") != 0 && normalizedUrl.find("https://") != 0) {
    normalizedUrl = "https://" + normalizedUrl;  // Default to HTTPS
  }

  // check if db has the server details
  Checkpoint::Server serverConfig = CheckpointConfig::GetServerConfigByUrl(normalizedUrl);

  // add `backend.` subdomain to normalizedUrl if not present
  std::string backendUrl = "https://backend." + normalizedUrl.substr(normalizedUrl.find("://") + 3);

  cpr::Response detailsResult = cpr::Get(cpr::Url{backendUrl + "/details"});

  if (detailsResult.status_code != 200) {
    std::string error = "Failed to fetch server details: " + detailsResult.status_line;
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  json response = json::parse(detailsResult.text);

  serverConfig.name = response["name"].get<std::string>();
  serverConfig.graphqlUrl = response["graphqlUrl"].get<std::string>();

  serverConfig.id = CheckpointConfig::RefreshServerDetails(serverConfig);

  if (serverConfig.id.empty()) {
    std::string error = "Failed to refresh server details";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  result->success = true;
  return result;
}
