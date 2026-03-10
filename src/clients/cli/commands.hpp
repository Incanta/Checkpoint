#pragma once

#include <algorithm>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "daemon_client.hpp"
#include "terminal_menu.hpp"
#include "types.hpp"
#include "workspace.hpp"

namespace checkpoint {
namespace fs = std::filesystem;

// ─── Color helpers (ANSI escape codes) ───────────────────────────

namespace color {
inline std::string reset() { return "\033[0m"; }
inline std::string bold() { return "\033[1m"; }
inline std::string dim() { return "\033[2m"; }
inline std::string red() { return "\033[31m"; }
inline std::string green() { return "\033[32m"; }
inline std::string yellow() { return "\033[33m"; }
inline std::string blue() { return "\033[34m"; }
inline std::string magenta() { return "\033[35m"; }
inline std::string cyan() { return "\033[36m"; }
inline std::string white() { return "\033[37m"; }

inline std::string statusColor(FileStatus status) {
  switch (status) {
    case FileStatus::Added:
      return green();
    case FileStatus::Local:
      return red();
    case FileStatus::Deleted:
      return red();
    case FileStatus::Renamed:
      return yellow();
    case FileStatus::ChangedNotCheckedOut:
      return yellow();
    case FileStatus::ChangedCheckedOut:
      return green();
    case FileStatus::NotChangedCheckedOut:
      return cyan();
    case FileStatus::Conflicted:
      return red() + bold();
    case FileStatus::MergeConflict:
      return red() + bold();
    default:
      return dim();
  }
}
}  // namespace color

// ─── Helper: get workspace context ───────────────────────────────

struct WorkspaceContext {
  DaemonClient client;
  WorkspaceConfig workspace;
  fs::path root;
};

inline WorkspaceContext getWorkspaceContext() {
  int port = getDaemonPort();
  std::string baseUrl = "http://127.0.0.1:" + std::to_string(port);
  DaemonClient client(baseUrl);

  fs::path cwd = fs::current_path();
  fs::path root = findWorkspaceRoot(cwd);
  WorkspaceConfig ws = readWorkspaceConfig(root);

  return {std::move(client), std::move(ws), root};
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: status
// ═════════════════════════════════════════════════════════════════

inline int cmdStatus() {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
  };

  auto result = client.query("workspaces.pending.refresh", input);

  if (result.is_null()) {
    std::cout << "No pending changes." << std::endl;
    return 0;
  }

  PendingChanges pending;
  from_json(result, pending);

  // Also get sync status
  nlohmann::json syncInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"forceRefresh", false},
  };

  SyncStatus syncStatus;
  try {
    auto syncResult = client.query("workspaces.sync.getSyncStatus", syncInput);
    if (!syncResult.is_null()) {
      from_json(syncResult, syncStatus);
    }
  } catch (...) {
    // Sync status may fail if workspace is not yet synced
  }

  // Print header
  std::cout << color::bold() << "On branch " << color::cyan()
            << ws.branchName << color::reset() << std::endl;
  std::cout << color::dim() << "Workspace: " << ws.workspaceName
            << " (" << ws.id << ")" << color::reset() << std::endl;

  if (!syncStatus.upToDate && syncStatus.changelistsBehind > 0) {
    std::cout << color::yellow() << "Your workspace is "
              << syncStatus.changelistsBehind << " changelist(s) behind remote."
              << color::reset() << std::endl;
    std::cout << color::dim() << "  (use \"chk pull\" to sync)"
              << color::reset() << std::endl;
  }

  std::cout << std::endl;

  if (pending.files.empty()) {
    std::cout << "No pending changes." << std::endl;
    return 0;
  }

  // Categorize files
  std::vector<std::pair<std::string, FileStatus>> staged;
  std::vector<std::pair<std::string, FileStatus>> unstaged;

  for (auto& [path, file] : pending.files) {
    auto status = static_cast<FileStatus>(file.status);
    switch (status) {
      case FileStatus::Added:
      case FileStatus::ChangedCheckedOut:
      case FileStatus::NotChangedCheckedOut:
      case FileStatus::Renamed:
        staged.push_back({path, status});
        break;
      case FileStatus::Local:
      case FileStatus::Deleted:
      case FileStatus::ChangedNotCheckedOut:
      case FileStatus::Conflicted:
      case FileStatus::MergeConflict:
        unstaged.push_back({path, status});
        break;
      default:
        unstaged.push_back({path, status});
        break;
    }
  }

  // Print staged changes
  if (!staged.empty()) {
    std::cout << color::bold() << "Changes to be submitted:" << color::reset() << std::endl;
    std::cout << color::dim() << "  (use \"chk restore --staged <file>\" to unstage)"
              << color::reset() << std::endl;
    std::cout << std::endl;
    for (auto& [path, status] : staged) {
      std::cout << "  " << color::statusColor(status)
                << fileStatusSymbol(status) << " " << path
                << color::reset() << std::endl;
    }
    std::cout << std::endl;
  }

  // Print unstaged changes
  if (!unstaged.empty()) {
    std::cout << color::bold() << "Changes not staged for submit:" << color::reset() << std::endl;
    std::cout << color::dim() << "  (use \"chk add <file>\" to stage new files)"
              << color::reset() << std::endl;
    std::cout << color::dim() << "  (use \"chk checkout <file>\" to check out controlled files)"
              << color::reset() << std::endl;
    std::cout << std::endl;
    for (auto& [path, status] : unstaged) {
      std::cout << "  " << color::statusColor(status)
                << fileStatusSymbol(status) << " " << path
                << " (" << fileStatusToString(status) << ")"
                << color::reset() << std::endl;
    }
    std::cout << std::endl;
  }

  std::cout << pending.numChanges << " file(s) changed total." << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: add (stage files — mark for add)
// ═════════════════════════════════════════════════════════════════

inline int cmdAdd(const std::vector<std::string>& files) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  // Resolve file paths relative to workspace root
  std::vector<std::string> resolvedPaths;
  for (auto& file : files) {
    std::string resolved = resolveWorkspacePath(ctx.root, file);
    resolvedPaths.push_back(resolved);
  }

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"paths", resolvedPaths},
  };

  auto result = client.mutate("workspaces.pending.markForAdd", input);

  for (auto& path : resolvedPaths) {
    std::cout << color::green() << "  + " << path << color::reset() << std::endl;
  }
  std::cout << resolvedPaths.size() << " file(s) staged." << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: restore (unstage files — unmark for add, or revert)
// ═════════════════════════════════════════════════════════════════

inline int cmdRestore(const std::vector<std::string>& files, bool staged) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  std::vector<std::string> resolvedPaths;
  for (auto& file : files) {
    std::string resolved = resolveWorkspacePath(ctx.root, file);
    resolvedPaths.push_back(resolved);
  }

  if (staged) {
    // Unstage: unmark for add
    nlohmann::json input = {
        {"daemonId", ws.daemonId},
        {"workspaceId", ws.id},
        {"paths", resolvedPaths},
    };

    client.mutate("workspaces.pending.unmarkForAdd", input);

    for (auto& path : resolvedPaths) {
      std::cout << color::yellow() << "  - " << path << color::reset() << std::endl;
    }
    std::cout << resolvedPaths.size() << " file(s) unstaged." << std::endl;
  } else {
    // Revert: restore head content + undo checkout
    nlohmann::json input = {
        {"daemonId", ws.daemonId},
        {"workspaceId", ws.id},
        {"filePaths", resolvedPaths},
    };

    auto result = client.mutate("workspaces.pending.revertFiles", input);

    for (auto& path : resolvedPaths) {
      std::cout << color::yellow() << "  ~ " << path << color::reset() << std::endl;
    }
    std::cout << resolvedPaths.size() << " file(s) reverted." << std::endl;
  }

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: submit (push a version)
// ═════════════════════════════════════════════════════════════════

inline int cmdSubmit(const std::string& message) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  // First refresh to get current pending changes
  nlohmann::json refreshInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
  };

  auto refreshResult = client.query("workspaces.pending.refresh", refreshInput);

  if (refreshResult.is_null()) {
    std::cerr << "No pending changes to submit." << std::endl;
    return 1;
  }

  PendingChanges pending;
  from_json(refreshResult, pending);

  // Build modifications list from staged files
  nlohmann::json modifications = nlohmann::json::array();
  int stagedCount = 0;

  for (auto& [path, file] : pending.files) {
    auto status = static_cast<FileStatus>(file.status);
    switch (status) {
      case FileStatus::Added:
      case FileStatus::ChangedCheckedOut:
      case FileStatus::Renamed:
        modifications.push_back({
            {"path", path},
            {"delete", false},
        });
        stagedCount++;
        break;
      case FileStatus::Deleted:
        // Only include deleted files if they were controlled (checked out)
        modifications.push_back({
            {"path", path},
            {"delete", true},
        });
        stagedCount++;
        break;
      default:
        break;
    }
  }

  if (stagedCount == 0) {
    std::cerr << "No staged changes to submit." << std::endl;
    std::cerr << color::dim() << "  (use \"chk add <file>\" to stage files)"
              << color::reset() << std::endl;
    return 1;
  }

  // Submit
  nlohmann::json submitInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"message", message},
      {"modifications", modifications},
      {"shelved", false},
  };

  // Note: submit is a query in the daemon API, not a mutation
  client.query("workspaces.pending.submit", submitInput);

  std::cout << color::green() << color::bold()
            << "Successfully submitted " << stagedCount << " file(s)."
            << color::reset() << std::endl;
  std::cout << color::dim() << "Message: " << message << color::reset() << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: pull (sync changes down)
// ═════════════════════════════════════════════════════════════════

inline int cmdPull() {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  // First check sync status
  nlohmann::json syncInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"forceRefresh", true},
  };

  auto syncResult = client.query("workspaces.sync.getSyncStatus", syncInput);
  SyncStatus syncStatus;
  if (!syncResult.is_null()) {
    from_json(syncResult, syncStatus);
  }

  if (syncStatus.upToDate) {
    std::cout << "Already up to date." << std::endl;
    return 0;
  }

  std::cout << "Pulling " << syncStatus.changelistsBehind
            << " changelist(s) from remote..." << std::endl;

  // Pull all changes (null changelistId = pull all, null filePaths = all files)
  nlohmann::json pullInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"changelistId", nullptr},
      {"filePaths", nullptr},
  };

  auto pullResult = client.query("workspaces.sync.pull", pullInput);

  std::cout << color::green() << color::bold()
            << "Pull complete." << color::reset() << std::endl;

  // Report merge results if any
  if (!pullResult.is_null()) {
    if (pullResult.contains("cleanMerges") && pullResult["cleanMerges"].is_array()) {
      auto& cleanMerges = pullResult["cleanMerges"];
      if (!cleanMerges.empty()) {
        std::cout << color::cyan() << cleanMerges.size()
                  << " file(s) auto-merged." << color::reset() << std::endl;
      }
    }
    if (pullResult.contains("conflictMerges") && pullResult["conflictMerges"].is_array()) {
      auto& conflictMerges = pullResult["conflictMerges"];
      if (!conflictMerges.empty()) {
        std::cout << color::red() << color::bold()
                  << conflictMerges.size() << " file(s) have merge conflicts!"
                  << color::reset() << std::endl;
        for (auto& cf : conflictMerges) {
          if (cf.is_string()) {
            std::cout << "  " << color::red() << "! " << cf.get<std::string>()
                      << color::reset() << std::endl;
          }
        }
      }
    }
  }

  std::cout << "Updated to changelist #" << syncStatus.remoteHeadNumber << "." << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: log (show history)
// ═════════════════════════════════════════════════════════════════

inline int cmdLog() {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
  };

  auto result = client.query("workspaces.history.get", input);

  if (result.is_null() || !result.is_array() || result.empty()) {
    std::cout << "No history found." << std::endl;
    return 0;
  }

  for (auto& entry : result) {
    Changelist cl;
    from_json(entry, cl);

    std::cout << color::yellow() << "changelist " << cl.number
              << color::reset() << std::endl;

    std::string author;
    if (!cl.user.name.empty()) {
      author = cl.user.name;
    } else if (!cl.user.username.empty()) {
      author = cl.user.username;
    } else {
      author = cl.user.email;
    }

    if (!author.empty()) {
      std::cout << "Author: " << author << std::endl;
    }
    if (!cl.createdAt.empty()) {
      std::cout << "Date:   " << cl.createdAt << std::endl;
    }
    std::cout << std::endl;
    if (!cl.message.empty()) {
      std::cout << "    " << cl.message << std::endl;
    } else {
      std::cout << "    " << color::dim() << "(no message)" << color::reset() << std::endl;
    }
    std::cout << std::endl;
  }

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: branch (list branches)
// ═════════════════════════════════════════════════════════════════

inline int cmdBranch() {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"includeArchived", false},
  };

  auto result = client.query("workspaces.branches.list", input);

  if (result.is_null()) {
    std::cout << "No branches found." << std::endl;
    return 0;
  }

  std::string currentBranch;
  if (result.contains("currentBranchName")) {
    currentBranch = result["currentBranchName"].get<std::string>();
  }

  std::vector<Branch> branches;
  if (result.contains("branches") && result["branches"].is_array()) {
    for (auto& entry : result["branches"]) {
      Branch b;
      from_json(entry, b);
      branches.push_back(b);
    }
  }

  if (branches.empty()) {
    std::cout << "No branches found." << std::endl;
    return 0;
  }

  for (auto& branch : branches) {
    bool isCurrent = (branch.name == currentBranch);
    if (isCurrent) {
      std::cout << color::green() << "* " << branch.name << color::reset();
    } else {
      std::cout << "  " << branch.name;
    }

    // Show branch type and head
    std::cout << color::dim();
    if (!branch.type.empty()) {
      std::cout << " [" << branch.type << "]";
    }
    if (branch.headNumber > 0) {
      std::cout << " (head: #" << branch.headNumber << ")";
    }
    if (!branch.parentBranchName.empty()) {
      std::cout << " <- " << branch.parentBranchName;
    }
    std::cout << color::reset() << std::endl;
  }

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: checkout (check out a controlled file)
// ═════════════════════════════════════════════════════════════════

inline int cmdCheckout(const std::string& file, bool locked) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  std::string resolved = resolveWorkspacePath(ctx.root, file);

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"path", resolved},
      {"locked", locked},
  };

  client.mutate("workspaces.pending.checkout", input);

  std::cout << color::green() << "Checked out: " << resolved << color::reset();
  if (locked) {
    std::cout << " (locked)";
  }
  std::cout << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: revert (revert files to head)
// ═════════════════════════════════════════════════════════════════

inline int cmdRevert(const std::vector<std::string>& files) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  std::vector<std::string> resolvedPaths;
  for (auto& file : files) {
    std::string resolved = resolveWorkspacePath(ctx.root, file);
    resolvedPaths.push_back(resolved);
  }

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"filePaths", resolvedPaths},
  };

  client.mutate("workspaces.pending.revertFiles", input);

  for (auto& path : resolvedPaths) {
    std::cout << color::yellow() << "  ~ " << path << color::reset() << std::endl;
  }
  std::cout << resolvedPaths.size() << " file(s) reverted." << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: diff (show diff for a file)
// ═════════════════════════════════════════════════════════════════

inline int cmdDiff(const std::string& file) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  std::string resolved = resolveWorkspacePath(ctx.root, file);

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"path", resolved},
  };

  auto result = client.query("workspaces.pending.diffFile", input);

  if (result.is_null()) {
    std::cout << "No diff available for: " << resolved << std::endl;
    return 0;
  }

  std::string left = result.value("left", "");
  std::string right = result.value("right", "");

  if (left.empty() && right.empty()) {
    std::cout << "No changes detected for: " << resolved << std::endl;
    return 0;
  }

  // Simple unified-style diff output
  std::cout << color::bold() << "--- a/" << resolved << color::reset() << std::endl;
  std::cout << color::bold() << "+++ b/" << resolved << color::reset() << std::endl;

  // Split into lines and show differences
  auto splitLines = [](const std::string& text) -> std::vector<std::string> {
    std::vector<std::string> lines;
    std::istringstream stream(text);
    std::string line;
    while (std::getline(stream, line)) {
      lines.push_back(line);
    }
    return lines;
  };

  auto leftLines = splitLines(left);
  auto rightLines = splitLines(right);

  // Simple line-by-line comparison
  size_t maxLines = std::max(leftLines.size(), rightLines.size());
  for (size_t i = 0; i < maxLines; i++) {
    std::string l = (i < leftLines.size()) ? leftLines[i] : "";
    std::string r = (i < rightLines.size()) ? rightLines[i] : "";

    if (l != r) {
      if (!l.empty()) {
        std::cout << color::red() << "-" << l << color::reset() << std::endl;
      }
      if (!r.empty()) {
        std::cout << color::green() << "+" << r << color::reset() << std::endl;
      }
    } else {
      std::cout << " " << l << std::endl;
    }
  }

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: init (initialize a workspace)
// ═════════════════════════════════════════════════════════════════

inline int cmdInit(const std::string& repoArg) {
  fs::path cwd = fs::current_path();

  // Check if workspace already exists
  if (fs::exists(cwd / ".checkpoint")) {
    std::cerr << color::red() << "error: workspace already initialized in this directory."
              << color::reset() << std::endl;
    return 1;
  }

  // Connect to daemon
  int port = getDaemonPort();
  std::string baseUrl = "http://127.0.0.1:" + std::to_string(port);
  DaemonClient client(baseUrl);

  // Get authenticated user / daemon id
  auto usersResult = client.query("auth.getUsers");
  if (usersResult.is_null() || !usersResult.is_array() || usersResult.empty()) {
    std::cerr << color::red()
              << "error: not authenticated."
              << color::reset() << std::endl;
    return 1;
  }

  User user;
  from_json(usersResult[0], user);
  std::string daemonId = user.daemonId;

  if (daemonId.empty()) {
    std::cerr << color::red() << "error: could not determine daemon ID from auth."
              << color::reset() << std::endl;
    return 1;
  }

  // Fetch orgs
  nlohmann::json orgsInput = {{"daemonId", daemonId}};
  auto orgsResult = client.query("orgs.list", orgsInput);

  if (orgsResult.is_null() || !orgsResult.is_array() || orgsResult.empty()) {
    std::cerr << color::red()
              << "error: no organizations found. Create one in the Checkpoint web app first."
              << color::reset() << std::endl;
    return 1;
  }

  std::vector<Org> orgs;
  for (auto& entry : orgsResult) {
    Org o;
    from_json(entry, o);
    orgs.push_back(o);
  }

  std::string selectedOrgId;
  std::string selectedOrgName;
  std::string selectedRepoId;
  std::string selectedRepoName;

  if (!repoArg.empty()) {
    // Parse orgName/repoName
    auto slashPos = repoArg.find('/');
    if (slashPos == std::string::npos) {
      std::cerr << color::red()
                << "error: invalid format. Expected orgName/repoName."
                << color::reset() << std::endl;
      return 1;
    }

    std::string orgName = repoArg.substr(0, slashPos);
    std::string repoName = repoArg.substr(slashPos + 1);

    // Find org by name
    for (auto& org : orgs) {
      if (org.name == orgName) {
        selectedOrgId = org.id;
        selectedOrgName = org.name;
        // Find repo by name within the org
        for (auto& repo : org.repos) {
          if (repo.name == repoName) {
            selectedRepoId = repo.id;
            selectedRepoName = repo.name;
            break;
          }
        }
        break;
      }
    }

    if (selectedOrgId.empty()) {
      std::cerr << color::red() << "error: organization '" << orgName
                << "' not found." << color::reset() << std::endl;
      return 1;
    }
    if (selectedRepoId.empty()) {
      std::cerr << color::red() << "error: repository '" << repoName
                << "' not found in organization '" << orgName << "'."
                << color::reset() << std::endl;
      return 1;
    }
  } else {
    // Interactive org selection
    std::vector<std::string> orgNames;
    for (auto& org : orgs) {
      orgNames.push_back(org.name);
    }

    auto orgChoice = interactiveSelect("Select an organization:", orgNames);
    if (!orgChoice.has_value()) {
      std::cout << "Cancelled." << std::endl;
      return 1;
    }

    auto& chosenOrg = orgs[orgChoice.value()];
    selectedOrgId = chosenOrg.id;
    selectedOrgName = chosenOrg.name;

    if (chosenOrg.repos.empty()) {
      std::cerr << color::red()
                << "error: no repositories in organization '" << chosenOrg.name
                << "'. Create one in the web app first."
                << color::reset() << std::endl;
      return 1;
    }

    // Interactive repo selection
    std::vector<std::string> repoNames;
    for (auto& repo : chosenOrg.repos) {
      repoNames.push_back(repo.name);
    }

    auto repoChoice = interactiveSelect("Select a repository:", repoNames);
    if (!repoChoice.has_value()) {
      std::cout << "Cancelled." << std::endl;
      return 1;
    }

    auto& chosenRepo = chosenOrg.repos[repoChoice.value()];
    selectedRepoId = chosenRepo.id;
    selectedRepoName = chosenRepo.name;
  }

  // Use the current directory name as the workspace name
  std::string workspaceName = cwd.filename().string();
  std::string localPath = cwd.string();

  // Replace backslashes with forward slashes for consistency
  std::replace(localPath.begin(), localPath.end(), '\\', '/');

  std::cout << "Initializing workspace for "
            << color::bold() << selectedOrgName << "/" << selectedRepoName
            << color::reset() << "..." << std::endl;

  // Create workspace via daemon
  nlohmann::json createInput = {
      {"daemonId", daemonId},
      {"name", workspaceName},
      {"repoId", selectedRepoId},
      {"path", localPath},
      {"defaultBranchName", "main"},
  };

  auto result = client.mutate("workspaces.ops.create", createInput);

  std::cout << color::green() << color::bold()
            << "Workspace initialized successfully!" << color::reset() << std::endl;
  std::cout << color::dim() << "  Organization: " << selectedOrgName << color::reset() << std::endl;
  std::cout << color::dim() << "  Repository:   " << selectedRepoName << color::reset() << std::endl;
  std::cout << color::dim() << "  Workspace:    " << workspaceName << color::reset() << std::endl;
  std::cout << color::dim() << "  Path:         " << localPath << color::reset() << std::endl;

  return 0;
}

}  // namespace checkpoint
