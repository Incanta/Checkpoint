#include "config.h"

#include <ctime>
#include <fstream>
#include <iostream>
#include <map>

#include "json.hpp"

using json = nlohmann::json;

struct CacheEntry {
  std::string value;
  std::time_t timestamp;
};

std::map<std::string, CacheEntry> ConfigCache;

std::string CheckpointConfig::GetConfigDir() {
#if defined(_WIN32) || defined(_WIN64)
  std::string homeDir = std::string(getenv("HOMEDRIVE")) + std::string(getenv("HOMEPATH"));
#else
  std::string homeDir = getenv("HOME");
#endif

  return homeDir + CheckpointConfig::sep + ".config" + CheckpointConfig::sep + "checkpoint";
}

std::string CheckpointConfig::GetAuthToken() {
  // Check if the auth token is already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("auth_token");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    return it->second.value;
  }

  // If not cached or expired, read the auth token from the file

  std::string authFilePath = CheckpointConfig::GetConfigDir() + CheckpointConfig::sep + "auth.json";

  std::ifstream authFile(authFilePath);
  if (!authFile.is_open()) {
    std::cerr << "Error: Unable to open auth file at " << authFilePath << std::endl;
    return "";
  }

  std::string contents((std::istreambuf_iterator<char>(authFile)), std::istreambuf_iterator<char>());
  authFile.close();

  json authData = json::parse(contents);

  if (authData.contains("access_token")) {
    std::string accessToken = authData["access_token"];
    // Cache the auth token and its expiration time
    ConfigCache["auth_token"] = CacheEntry{accessToken, currentTime};
    return accessToken;
  } else {
    std::cerr << "Error: access_token not found in auth file." << std::endl;
    return "";
  }
}

std::string CheckpointConfig::GetGraphQLUrl() {
  // Check if already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("config");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    json configData = json::parse(it->second.value);

    if (configData.contains("graphql_url")) {
      return configData["graphql_url"];
    }
  }

  std::string configDir = CheckpointConfig::GetConfigDir();
  std::string configFilePath = configDir + CheckpointConfig::sep + "config.json";

  std::ifstream configFile(configFilePath);
  if (!configFile.is_open()) {
    std::cerr << "Error: Unable to open config file at " << configFilePath << std::endl;
    return "";
  }

  std::string contents((std::istreambuf_iterator<char>(configFile)), std::istreambuf_iterator<char>());
  configFile.close();

  ConfigCache["config"] = CacheEntry{contents, currentTime};

  json configData = json::parse(contents);

  if (configData.contains("graphql_url")) {
    return configData["graphql_url"];
  } else {
    std::cerr << "Error: graphql_url not found in config file." << std::endl;
    return "";
  }
}

std::string CheckpointConfig::GetAuth0Url() {
  // Check if already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("config");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    json configData = json::parse(it->second.value);

    if (configData.contains("auth0") && configData["auth0"].contains("url")) {
      return configData["auth0"]["url"];
    }
  }

  std::string configDir = CheckpointConfig::GetConfigDir();
  std::string configFilePath = configDir + CheckpointConfig::sep + "config.json";

  std::ifstream configFile(configFilePath);
  if (!configFile.is_open()) {
    std::cerr << "Error: Unable to open config file at " << configFilePath << std::endl;
    return "";
  }

  std::string contents((std::istreambuf_iterator<char>(configFile)), std::istreambuf_iterator<char>());
  configFile.close();

  ConfigCache["config"] = CacheEntry{contents, currentTime};

  json configData = json::parse(contents);

  if (configData.contains("auth0") && configData["auth0"].contains("url")) {
    return configData["auth0"]["url"];
  } else {
    std::cerr << "Error: Auth0 URL not found in config file." << std::endl;
    return "";
  }
}

std::string CheckpointConfig::GetAuth0ClientId() {
  // Check if already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("config");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    json configData = json::parse(it->second.value);

    if (configData.contains("auth0") && configData["auth0"].contains("clientId")) {
      return configData["auth0"]["clientId"];
    }
  }

  std::string configDir = CheckpointConfig::GetConfigDir();
  std::string configFilePath = configDir + CheckpointConfig::sep + "config.json";

  std::ifstream configFile(configFilePath);
  if (!configFile.is_open()) {
    std::cerr << "Error: Unable to open config file at " << configFilePath << std::endl;
    return "";
  }

  std::string contents((std::istreambuf_iterator<char>(configFile)), std::istreambuf_iterator<char>());
  configFile.close();

  ConfigCache["config"] = CacheEntry{contents, currentTime};

  json configData = json::parse(contents);

  if (configData.contains("auth0") && configData["auth0"].contains("clientId")) {
    return configData["auth0"]["clientId"];
  } else {
    std::cerr << "Error: Auth0 Client ID not found in config file." << std::endl;
    return "";
  }
}

std::string CheckpointConfig::GetAuth0Audience() {
  // Check if already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("config");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    json configData = json::parse(it->second.value);

    if (configData.contains("auth0") && configData["auth0"].contains("audienceApi")) {
      return configData["auth0"]["audienceApi"];
    }
  }

  std::string configDir = CheckpointConfig::GetConfigDir();
  std::string configFilePath = configDir + CheckpointConfig::sep + "config.json";

  std::ifstream configFile(configFilePath);
  if (!configFile.is_open()) {
    std::cerr << "Error: Unable to open config file at " << configFilePath << std::endl;
    return "";
  }

  std::string contents((std::istreambuf_iterator<char>(configFile)), std::istreambuf_iterator<char>());
  configFile.close();

  ConfigCache["config"] = CacheEntry{contents, currentTime};

  json configData = json::parse(contents);

  if (configData.contains("auth0") && configData["auth0"].contains("audienceApi")) {
    return configData["auth0"]["audienceApi"];
  } else {
    std::cerr << "Error: Auth0 Audience not found in config file." << std::endl;
    return "";
  }
}
