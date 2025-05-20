#include "config.h"

#include <migrations.h>
#include <sqlite3.h>

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

sqlite3 *GlobalDb = nullptr;
std::string WorkspaceDbPath;
sqlite3 *WorkspaceDb = nullptr;

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
  auto it = ConfigCache.find("graphql_url");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    return it->second.value;
  }

  std::string value = CheckpointConfig::GetGlobalConfigVar("graphql_url");
  ConfigCache["graphql_url"] = CacheEntry{value, currentTime};
  return value;
}

std::string CheckpointConfig::GetAuth0Url() {
  // Check if already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("auth0_url");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    return it->second.value;
  }

  std::string value = CheckpointConfig::GetGlobalConfigVar("auth0_url");
  ConfigCache["auth0_url"] = CacheEntry{value, currentTime};
  return value;
}

std::string CheckpointConfig::GetAuth0ClientId() {
  // Check if already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("auth0_client_id");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    return it->second.value;
  }

  std::string value = CheckpointConfig::GetGlobalConfigVar("auth0_client_id");
  ConfigCache["auth0_client_id"] = CacheEntry{value, currentTime};
  return value;
}

std::string CheckpointConfig::GetAuth0Audience() {
  // Check if already cached (1 minute expiration)
  std::time_t currentTime = std::time(nullptr);
  auto it = ConfigCache.find("config");
  if (it != ConfigCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    return it->second.value;
  }

  std::string value = CheckpointConfig::GetGlobalConfigVar("auth0_audience");
  ConfigCache["auth0_audience"] = CacheEntry{value, currentTime};
  return value;
}

int OpenDatabase(const std::string &dbPath, sqlite3 **db) {
  int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  int err = sqlite3_open_v2(dbPath.c_str(), db, flags, nullptr);

  if (*db == nullptr) {
    std::cerr << "Error allocating ram for SQLite db" << std::endl;
    return err;
  }

  if (err != SQLITE_OK) {
    std::cerr << "Error opening database: " << sqlite3_errmsg(*db) << std::endl;
    sqlite3_close(*db);
    return err;
  }

  return SQLITE_OK;
}

void MigrateDatabase(sqlite3 *db) {
  int err = SQLITE_OK;

  for (const auto &migration : Migrations::migrations) {
    std::string migrationName = migration.first;
    std::string sql = migration.second;

    // check if the migration has already been applied in the Migration table
    std::string checkSql = "SELECT COUNT(*) FROM Migration WHERE name='" + migrationName + "'";
    int count = -1;
    err = sqlite3_exec(
        db,
        checkSql.c_str(),
        [](void *data, int argc, char **argv, char **azColName) {
          if (argc > 0 && argv[0] != nullptr) {
            int *count = static_cast<int *>(data);
            *count = std::stoi(argv[0]);
          }
          return 0;
        },
        &count,
        nullptr);
    if (err != SQLITE_OK) {
      std::cerr << "Error executing query: " << sqlite3_errmsg(db) << std::endl;
    }

    if (count == 0) {
      // Migration has not been applied, so apply it
      err = sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr);
      if (err != SQLITE_OK) {
        std::cerr << "Error applying migration: " << sqlite3_errmsg(db) << std::endl;
      } else {
        // Insert the migration name into the Migration table
        std::string insertSql = "INSERT INTO Migration (name) VALUES ('" + migrationName + "')";
        err = sqlite3_exec(db, insertSql.c_str(), nullptr, nullptr, nullptr);
        if (err != SQLITE_OK) {
          std::cerr << "Error inserting migration name: " << sqlite3_errmsg(db) << std::endl;
        }
      }
    }
  }
}

bool EnsureGlobalDb() {
  if (GlobalDb == nullptr) {
    std::string configDir = CheckpointConfig::GetConfigDir();
    std::string configFilePath = configDir + CheckpointConfig::sep + "global.db";

    int err = OpenDatabase(configFilePath, &GlobalDb);
    if (err != SQLITE_OK) {
      return false;
    }
  }

  return true;
}

bool EnsureWorkspaceDb(Checkpoint::Workspace *workspace) {
  if (WorkspaceDb == nullptr || WorkspaceDbPath != std::string(workspace->localRoot)) {
    if (WorkspaceDb != nullptr) {
      sqlite3_close(WorkspaceDb);
    }
    WorkspaceDbPath = std::string(workspace->localRoot);

    std::string configDir = CheckpointConfig::GetConfigDir();
    std::string workspaceDir = std::string(workspace->localRoot);
    std::string workspaceFilePath = workspaceDir + CheckpointConfig::sep + "workspace.db";

    int err = OpenDatabase(workspaceFilePath, &WorkspaceDb);
    if (err != SQLITE_OK) {
      return false;
    }
  }

  return true;
}

void CheckpointConfig::MigrateGlobalDatabase() {
  if (EnsureGlobalDb()) {
    MigrateDatabase(GlobalDb);
  }
}

void CheckpointConfig::MigrateWorkspaceDatabase(Checkpoint::Workspace *workspace) {
  if (EnsureWorkspaceDb(workspace)) {
    MigrateDatabase(WorkspaceDb);
  }
}

std::string GetConfigVar(sqlite3 *db, std::string varName) {
  std::string result = "";  // Variable to store the result
  std::string query = "SELECT value FROM Config WHERE name='" + varName + "'";

  int err = sqlite3_exec(
      db,
      query.c_str(),
      [](void *data, int argc, char **argv, char **azColName) {
        if (argc > 0 && argv[0] != nullptr) {
          std::string *result = static_cast<std::string *>(data);
          *result = argv[0];
        }
        return 0;
      },
      &result,  // Pass the address of result as user data
      nullptr);

  if (err != SQLITE_OK) {
    std::cerr << "Error executing query: " << sqlite3_errmsg(db) << std::endl;
  }

  return result;  // Return the actual result instead of empty string
}

std::string CheckpointConfig::GetGlobalConfigVar(const std::string &varName) {
  if (EnsureGlobalDb()) {
    return GetConfigVar(GlobalDb, varName);
  }

  return "";
}

std::string CheckpointConfig::GetWorkspaceConfigVar(Checkpoint::Workspace *workspace, const std::string &varName) {
  if (EnsureWorkspaceDb(workspace)) {
    return GetConfigVar(WorkspaceDb, varName);
  }

  return "";
}

void SetConfigVar(sqlite3 *db, const std::string &varName, const std::string &value) {
  std::string query = "INSERT OR REPLACE INTO Config (name, value) VALUES ('" + varName + "', '" + value + "')";

  int err = sqlite3_exec(db, query.c_str(), nullptr, nullptr, nullptr);
  if (err != SQLITE_OK) {
    std::cerr << "Error executing query: " << sqlite3_errmsg(db) << std::endl;
  }
}

void CheckpointConfig::SetGlobalConfigVar(const std::string &varName, const std::string &value) {
  if (EnsureGlobalDb()) {
    SetConfigVar(GlobalDb, varName, value);
  }
}

void CheckpointConfig::SetWorkspaceConfigVar(Checkpoint::Workspace *workspace, const std::string &varName, const std::string &value) {
  if (EnsureWorkspaceDb(workspace)) {
    SetConfigVar(WorkspaceDb, varName, value);
  }
}
