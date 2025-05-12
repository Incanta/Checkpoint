#include <ctime>
#include <filesystem>
#include <iostream>
#include <string>

#include "../util/config.h"
#include "../util/graphql-client.h"
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

Checkpoint::ErrorResult* Checkpoint::Login() {
  Checkpoint::ErrorResult* result = new Checkpoint::ErrorResult();

  cpr::Response deviceCodeResult = cpr::Post(
      cpr::Url{CheckpointConfig::GetAuth0Url() + "/oauth/device/code"},
      cpr::Header{{"Content-Type", "application/x-www-form-urlencoded"}},
      cpr::Body{"client_id=" + CheckpointConfig::GetAuth0ClientId() + "&audience=" + CheckpointConfig::GetAuth0Audience() + "&scope=openid profile email"});

  if (deviceCodeResult.status_code != 200) {
    result->success = false;
    result->error = new char[deviceCodeResult.status_line.length() + 1];
    strcpy(result->error, deviceCodeResult.status_line.c_str());
    return result;
  }

  json response = json::parse(deviceCodeResult.text);

  int expires_in = response["expires_in"];
  std::time_t expirationTime = std::time(nullptr) + expires_in;

  std::string verification_uri = response["verification_uri_complete"];
  openURL(verification_uri);

  json tokenBody;

  while (true) {
    std::time_t currentTime = std::time(nullptr);
    if (currentTime >= expirationTime) {
      std::string error = "Login expired";
      result->success = false;
      result->error = new char[error.length() + 1];
      strcpy(result->error, error.c_str());
      return result;
    }

    cpr::Response tokenResponse = cpr::Post(
        cpr::Url{CheckpointConfig::GetAuth0Url() + "/oauth/token"},
        cpr::Header{{"Content-Type", "application/x-www-form-urlencoded"}},
        cpr::Body{"client_id=" + CheckpointConfig::GetAuth0ClientId() + "&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=" + std::string(response["device_code"])});

    json tokenResponseJson = json::parse(tokenResponse.text);

    if (tokenResponseJson.contains("error")) {
      if (tokenResponseJson["error"] == "expired_token") {
        std::string error = "Login expired";
        result->success = false;
        result->error = new char[error.length() + 1];
        strcpy(result->error, error.c_str());
        return result;
      }

      int waitTime = 1;
      if (tokenResponseJson.contains("interval")) {
        waitTime = tokenResponseJson["interval"];
      }
      std::this_thread::sleep_for(std::chrono::seconds(waitTime));
    } else {
      tokenBody = tokenResponseJson;
      break;
    }
  }

  fs::create_directories(CheckpointConfig::GetConfigDir());

  std::ofstream authFile(CheckpointConfig::GetConfigDir() + CheckpointConfig::sep + "auth.json");
  if (!authFile.is_open()) {
    std::string error = "Failed to open auth file for writing";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }
  authFile << tokenBody.dump(2);

  WhoamiResult* whoami = Checkpoint::Whoami();

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
