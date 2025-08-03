#include <ctime>
#include <filesystem>
#include <iostream>
#include <string>

#include "../util/config.h"
#include "../util/trpc-client.h"
#include "main.h"
#ifdef _WIN32
#include <Windows.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;

void openURL(std::string url) {
#ifdef _WIN32
  std::wstring ws;
  ws.assign(url.begin(), url.end());
  ShellExecute(0, 0, url.c_str(), 0, 0, SW_SHOW);
#elif __APPLE__
  std::string command = "open " + url;
  system(command.c_str());
#else
  std::string command = "xdg-open " + url;
  system(command.c_str());
#endif
}

std::string randomCode() {
  const char charset[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const size_t length = 8;  // Length of the random code
  std::string result;
  result.reserve(length + (length / 4 - 1));  // Reserve space for the code and hyphens

  for (size_t i = 0; i < length; ++i) {
    if (i == 3) {  // Insert a hyphen after the third character
      result += '-';
    }

    result += charset[rand() % (sizeof(charset) - 1)];
  }

  return result;
}

Checkpoint::ErrorResult* Checkpoint::Login(const char* serverId) {
  Checkpoint::ErrorResult* result = new Checkpoint::ErrorResult();

  Checkpoint::Server serverConfig = CheckpointConfig::GetServerConfig(serverId);
  if (serverConfig.id.empty()) {
    std::string error = "Server id '" + std::string(serverId) + "' not configured";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  std::string randomCodeStr = randomCode();
  std::cout << "Please open the following URL in your browser to log in: "
            << serverConfig.baseUrl + "/tokens" << std::endl
            << std::endl;

  std::cout << "Create a new API token with the Device Code:" << std::endl
            << std::endl
            << "\t" << randomCodeStr << std::endl
            << std::endl;

  openURL(serverConfig.baseUrl + "/tokens");

  json tokenBody;

  while (true) {
    json input = {{"deviceCode", randomCodeStr}};
    tokenBody = tRPCClient::Query(serverId, "auth.getApiToken", input);

    if (tokenBody.contains("error")) {
      std::cout << "Error: " << tokenBody["error"] << std::endl;
      std::this_thread::sleep_for(std::chrono::seconds(5));
      continue;
    }

    if (!tokenBody.contains("data") || !tokenBody["data"].contains("apiToken") || !tokenBody["data"]["apiToken"].contains("token")) {
      std::cout << "Invalid response format" << std::endl;
      result->success = false;
      result->error = new char[std::string("Invalid response format").length() + 1];
      strcpy(result->error, "Invalid response format");
      return result;
    }

    break;
  }

  serverConfig.accessToken = tokenBody["data"]["apiToken"]["token"];
  CheckpointConfig::RefreshServerDetails(serverConfig);

  WhoamiResult* whoami = Checkpoint::Whoami(serverId);

  if (!whoami->success) {
    std::string whoamiError = "Failed to get user information: " + std::string(whoami->error);
    result->success = false;
    result->error = new char[whoamiError.length() + 1];
    strcpy(result->error, whoamiError.c_str());
    FreeWhoami(whoami);
    return result;
  }

  FreeWhoami(whoami);

  result->success = true;
  return result;
}

void Checkpoint::FreeError(Checkpoint::ErrorResult* result) {
  if (result->error != nullptr) {
    delete[] result->error;
  }
  delete result;
}
