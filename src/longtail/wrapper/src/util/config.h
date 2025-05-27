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
std::string GetAuthToken();
std::string GetGraphQLUrl();
std::string GetAuth0Url();
std::string GetAuth0ClientId();
std::string GetAuth0Audience();

void MigrateGlobalDatabase();
void MigrateWorkspaceDatabase(Checkpoint::Workspace *workspace);

std::string GetGlobalConfigVar(const std::string &varName);
std::string GetWorkspaceConfigVar(Checkpoint::Workspace *workspace, const std::string &varName);

void SetGlobalConfigVar(const std::string &varName, const std::string &value);
void SetWorkspaceConfigVar(Checkpoint::Workspace *workspace, const std::string &varName, const std::string &value);

}  // namespace CheckpointConfig
