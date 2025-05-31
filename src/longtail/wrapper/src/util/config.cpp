#include "config.h"

#include <migrations.h>
#include <sqlite3.h>

#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>

#include "json.hpp"

using json = nlohmann::json;
namespace fs = std::filesystem;

struct ConfigCacheEntry {
  std::string value;
  std::time_t timestamp;
};

struct ServerCacheEntry {
  Checkpoint::Server value;
  std::time_t timestamp;
};

std::map<std::string, ConfigCacheEntry> ConfigCache;
std::map<std::string, ServerCacheEntry> ServerCache;

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

std::string CheckpointConfig::RefreshServerDetails(Checkpoint::Server &serverConfig) {
  if (EnsureGlobalDb()) {
    if (serverConfig.id.empty()) {
      // Insert new server config
      std::string query = "INSERT INTO Server (name, baseUrl, graphqlUrl) VALUES ('" +
                          serverConfig.name + "', '" + serverConfig.baseUrl + "', '" +
                          serverConfig.graphqlUrl;
      int err = sqlite3_exec(GlobalDb, query.c_str(), nullptr, nullptr, nullptr);
      if (err != SQLITE_OK) {
        std::cerr << "Error executing query: " << sqlite3_errmsg(GlobalDb) << std::endl;
        return std::string();
      }
      // Retrieve the last inserted row ID
      serverConfig.id = std::to_string(sqlite3_last_insert_rowid(GlobalDb));
    } else {
      // Update existing server config
      std::string query = "UPDATE Server SET name='" + serverConfig.name + "', baseUrl='" +
                          serverConfig.baseUrl + "', graphqlUrl='" + serverConfig.graphqlUrl +
                          "' WHERE id='" + serverConfig.id + "'";
      int err = sqlite3_exec(GlobalDb, query.c_str(), nullptr, nullptr, nullptr);
      if (err != SQLITE_OK) {
        std::cerr << "Error executing query: " << sqlite3_errmsg(GlobalDb) << std::endl;
        return std::string();
      }
    }

    return serverConfig.id;
  } else {
    return std::string();
  }
}

Checkpoint::Server CheckpointConfig::GetServerConfigByUrl(std::string serverUrl) {
  Checkpoint::Server serverConfig;

  if (EnsureGlobalDb()) {
    std::string query = "SELECT id, name, graphqlUrl, accessToken, expiresIn, idToken, scope, tokenType FROM Server WHERE baseUrl='" + serverUrl + "'";

    int err = sqlite3_exec(
        GlobalDb,
        query.c_str(),
        [](void *data, int argc, char **argv, char **azColName) {
          if (argc > 0 && argv[0] != nullptr) {
            Checkpoint::Server *config = reinterpret_cast<Checkpoint::Server *>(data);
            config->id = argv[0] ? argv[0] : "";
            config->name = argv[1] ? argv[1] : "";
            config->graphqlUrl = argv[2] ? argv[2] : "";
            config->accessToken = argv[3] ? argv[3] : "";
            config->expiresIn = argv[4] ? std::stoi(argv[4]) : -1;
            config->idToken = argv[5] ? argv[5] : "";
            config->scope = argv[6] ? argv[6] : "";
            config->tokenType = argv[7] ? argv[7] : "";
          }
          return 0;
        },
        &serverConfig,  // Pass the address of result as user data
        nullptr);

    if (err != SQLITE_OK) {
      std::cerr << "Error executing query: " << sqlite3_errmsg(GlobalDb) << std::endl;
    } else {
      // Cache the server config and its timestamp
      std::time_t currentTime = std::time(nullptr);
      ServerCache[serverConfig.id] = ServerCacheEntry{serverConfig, currentTime};
    }
  }

  return serverConfig;
}

Checkpoint::Server CheckpointConfig::GetServerConfig(Checkpoint::Workspace *workspace) {
  return GetServerConfig(std::string(workspace->serverId));
}

Checkpoint::Server CheckpointConfig::GetServerConfig(std::string serverId) {
  std::time_t currentTime = std::time(nullptr);
  auto it = ServerCache.find(serverId);
  if (it != ServerCache.end() && std::difftime(currentTime, it->second.timestamp) < 60) {
    return it->second.value;
  }

  Checkpoint::Server serverConfig;

  if (EnsureGlobalDb()) {
    std::string query = "SELECT id, name, graphqlUrl, accessToken, expiresIn, idToken, scope, tokenType FROM Server WHERE id='" + serverId + "'";

    int err = sqlite3_exec(
        GlobalDb,
        query.c_str(),
        [](void *data, int argc, char **argv, char **azColName) {
          if (argc > 0 && argv[0] != nullptr) {
            Checkpoint::Server *config = reinterpret_cast<Checkpoint::Server *>(data);
            config->id = argv[0] ? argv[0] : "";
            config->name = argv[1] ? argv[1] : "";
            config->graphqlUrl = argv[2] ? argv[2] : "";
            config->accessToken = argv[3] ? argv[3] : "";
            config->expiresIn = argv[4] ? std::stoi(argv[4]) : -1;
            config->idToken = argv[5] ? argv[5] : "";
            config->scope = argv[6] ? argv[6] : "";
            config->tokenType = argv[7] ? argv[7] : "";
          }
          return 0;
        },
        &serverConfig,  // Pass the address of result as user data
        nullptr);

    if (err != SQLITE_OK) {
      std::cerr << "Error executing query: " << sqlite3_errmsg(GlobalDb) << std::endl;
    } else {
      // Cache the server config and its timestamp
      ServerCache[serverId] = ServerCacheEntry{serverConfig, currentTime};
    }
  }

  return serverConfig;
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

std::string CheckpointConfig::GetWorkspaceConfigVar(
    Checkpoint::Workspace *workspace,
    const std::string &varName) {
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

void CheckpointConfig::SetGlobalConfigVar(
    const std::string &varName,
    const std::string &value) {
  if (EnsureGlobalDb()) {
    SetConfigVar(GlobalDb, varName, value);
  }
}

void CheckpointConfig::SetWorkspaceConfigVar(
    Checkpoint::Workspace *workspace,
    const std::string &varName,
    const std::string &value) {
  if (EnsureWorkspaceDb(workspace)) {
    SetConfigVar(WorkspaceDb, varName, value);
  }
}

void CheckpointConfig::StageFile(
    Checkpoint::Workspace *workspace,
    bool isStaged,
    const std::string &filePath) {
  if (!EnsureWorkspaceDb(workspace)) {
    std::cerr << "Failed to ensure workspace database" << std::endl;
    return;
  }

  // check if file exists
  fs::path fullPath = std::string(workspace->localRoot) + CheckpointConfig::sep + filePath;
  bool isDeleted = !fs::exists(fullPath);

  std::string query = "INSERT INTO File (path, deleted, staged) VALUES ('" + filePath + "', " +
                      (isDeleted ? "1" : "0") + ", " + (isStaged ? "1" : "0") + ") ON CONFLICT(path) DO UPDATE SET staged = " +
                      (isStaged ? "1" : "0") + ", deleted = " + (isDeleted ? "1" : "0");

  int err = sqlite3_exec(WorkspaceDb, query.c_str(), nullptr, nullptr, nullptr);
  if (err != SQLITE_OK) {
    std::cerr << "Error executing query: " << sqlite3_errmsg(WorkspaceDb) << std::endl;
  }
}

void CheckpointConfig::MarkFileRenamed(
    Checkpoint::Workspace *workspace,
    const std::string &oldFilePath,
    const std::string &currentFilePath) {
  if (!EnsureWorkspaceDb(workspace)) {
    std::cerr << "Failed to ensure workspace database" << std::endl;
    return;
  }

  // check if old file exists
  fs::path currentFullPath = std::string(workspace->localRoot) + CheckpointConfig::sep + currentFilePath;
  bool isDeleted = !fs::exists(currentFullPath);

  std::string query = "INSERT INTO File (path, oldPath, deleted) VALUES ('" + currentFilePath + "', " +
                      "'" + oldFilePath + "', " + (isDeleted ? "1" : "0") + ") ON CONFLICT(path) DO UPDATE SET deleted = " +
                      (isDeleted ? "1" : "0") + ", oldPath = '" + oldFilePath + "'";

  int err = sqlite3_exec(WorkspaceDb, query.c_str(), nullptr, nullptr, nullptr);
  if (err != SQLITE_OK) {
    std::cerr << "Error executing query: " << sqlite3_errmsg(WorkspaceDb) << std::endl;
  }
}
