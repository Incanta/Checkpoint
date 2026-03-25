#pragma once

#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <set>
#include <stdexcept>
#include <string>

#include "types.hpp"

namespace checkpoint {
namespace fs = std::filesystem;

/**
 * Reads the daemon port from ~/.checkpoint/daemon.json.
 * Falls back to default port 13010.
 */
inline int getDaemonPort() {
  std::string homeDir;
#ifdef _WIN32
  const char* userProfile = std::getenv("USERPROFILE");
  if (userProfile) {
    homeDir = userProfile;
  }
#else
  const char* home = std::getenv("HOME");
  if (home) {
    homeDir = home;
  }
#endif

  if (homeDir.empty()) {
    return 13010;  // default
  }

  fs::path configPath = fs::path(homeDir) / ".checkpoint" / "daemon.json";
  if (!fs::exists(configPath)) {
    return 13010;
  }

  try {
    std::ifstream file(configPath);
    nlohmann::json config = nlohmann::json::parse(file);
    if (config.contains("daemonPort")) {
      return config["daemonPort"].get<int>();
    }
  } catch (...) {
    // Fall through to default
  }

  return 13010;
}

/**
 * Walks up from the given directory to find a .checkpoint/ directory.
 * Returns the workspace root path, or throws if not found.
 */
inline fs::path findWorkspaceRoot(const fs::path& startDir) {
  fs::path current = fs::absolute(startDir);

  while (true) {
    fs::path checkpointDir = current / ".checkpoint";
    if (fs::exists(checkpointDir) && fs::is_directory(checkpointDir)) {
      return current;
    }

    fs::path parent = current.parent_path();
    if (parent == current) {
      break;  // reached root
    }
    current = parent;
  }

  throw std::runtime_error(
      "Not a Checkpoint workspace (or any parent up to the filesystem root).\n"
      "No .checkpoint directory found.");
}

/**
 * Reads workspace configuration from .checkpoint/workspace.json.
 */
inline WorkspaceConfig readWorkspaceConfig(const fs::path& workspaceRoot) {
  fs::path configPath = workspaceRoot / ".checkpoint" / "workspace.json";

  if (!fs::exists(configPath)) {
    throw std::runtime_error(
        "Workspace config not found: " + configPath.string() +
        "\nThis directory has a .checkpoint folder but no workspace.json.");
  }

  std::ifstream file(configPath);
  nlohmann::json j = nlohmann::json::parse(file);

  WorkspaceConfig ws;
  from_json(j, ws);

  // Set localPath to the workspace root if not present in the config
  if (ws.localPath.empty()) {
    ws.localPath = workspaceRoot.string();
  }

  return ws;
}

/**
 * Resolves a file path relative to the workspace root.
 * If the path is absolute, converts it to relative.
 * If relative, keeps it as-is (normalized with forward slashes).
 */
inline std::string resolveWorkspacePath(
    const fs::path& workspaceRoot,
    const std::string& inputPath) {
  fs::path resolved;

  if (fs::path(inputPath).is_absolute()) {
    resolved = fs::relative(fs::path(inputPath), workspaceRoot);
  } else {
    // Resolve relative to CWD, then make relative to workspace root
    fs::path absolute = fs::absolute(fs::path(inputPath));
    resolved = fs::relative(absolute, workspaceRoot);
  }

  // Normalize to forward slashes (cross-platform)
  std::string result = resolved.generic_string();
  return result;
}

// ─── staged.json management ──────────────────────────────────────

/**
 * Reads the set of staged file paths from .checkpoint/staged.json.
 * Returns an empty set if the file doesn't exist.
 */
inline std::set<std::string> readStagedFiles(const fs::path& workspaceRoot) {
  fs::path stagedPath = workspaceRoot / ".checkpoint" / "staged.json";
  std::set<std::string> staged;

  if (!fs::exists(stagedPath)) {
    return staged;
  }

  try {
    std::ifstream file(stagedPath);
    nlohmann::json j = nlohmann::json::parse(file);
    if (j.is_array()) {
      for (auto& entry : j) {
        if (entry.is_string()) {
          staged.insert(entry.get<std::string>());
        }
      }
    }
  } catch (...) {
    // Corrupted file — treat as empty
  }

  return staged;
}

/**
 * Writes the set of staged file paths to .checkpoint/staged.json.
 */
inline void writeStagedFiles(const fs::path& workspaceRoot,
                             const std::set<std::string>& staged) {
  fs::path stagedPath = workspaceRoot / ".checkpoint" / "staged.json";
  nlohmann::json j = nlohmann::json::array();
  for (auto& path : staged) {
    j.push_back(path);
  }
  std::ofstream file(stagedPath);
  file << j.dump(2);
}

/**
 * Adds paths to staged.json and returns the updated set.
 */
inline std::set<std::string> addStagedFiles(
    const fs::path& workspaceRoot,
    const std::vector<std::string>& paths) {
  auto staged = readStagedFiles(workspaceRoot);
  for (auto& p : paths) {
    staged.insert(p);
  }
  writeStagedFiles(workspaceRoot, staged);
  return staged;
}

/**
 * Removes paths from staged.json and returns the updated set.
 */
inline std::set<std::string> removeStagedFiles(
    const fs::path& workspaceRoot,
    const std::vector<std::string>& paths) {
  auto staged = readStagedFiles(workspaceRoot);
  for (auto& p : paths) {
    staged.erase(p);
  }
  writeStagedFiles(workspaceRoot, staged);
  return staged;
}

}  // namespace checkpoint
