#pragma once

#include <string>

#include "../exposed/types.h"

namespace CheckpointConfig {

#if defined(_WIN32) || defined(_WIN64)
static const std::string sep = "\\";
#else
static const std::string sep = "/";
#endif

std::string GetConfigDir();

std::string RefreshServerDetails(Checkpoint::Server &serverConfig);

Checkpoint::Server GetServerConfigByUrl(std::string serverUrl);
Checkpoint::Server GetServerConfig(std::string serverId);
Checkpoint::Server GetServerConfig(Checkpoint::Workspace *workspace);

void MigrateGlobalDatabase();
void MigrateWorkspaceDatabase(Checkpoint::Workspace *workspace);

std::string GetGlobalConfigVar(const std::string &varName);
std::string GetWorkspaceConfigVar(
    Checkpoint::Workspace *workspace,
    const std::string &varName);

void SetGlobalConfigVar(const std::string &varName, const std::string &value);
void SetWorkspaceConfigVar(
    Checkpoint::Workspace *workspace,
    const std::string &varName,
    const std::string &value);

void StageFile(
    Checkpoint::Workspace *workspace,
    bool isStaged,
    const std::string &filePath);

void MarkFileRenamed(
    Checkpoint::Workspace *workspace,
    const std::string &oldFilePath,
    const std::string &currentFilePath);

}  // namespace CheckpointConfig
