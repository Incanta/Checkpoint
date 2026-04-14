#pragma once

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <io.h>
#include <windows.h>
#else
#include <sys/ioctl.h>
#include <unistd.h>
#endif

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

// ─── Helper: get terminal width ──────────────────────────────────

inline int getTerminalWidth() {
#ifdef _WIN32
  CONSOLE_SCREEN_BUFFER_INFO csbi;
  if (GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &csbi)) {
    return csbi.srWindow.Right - csbi.srWindow.Left + 1;
  }
#else
  struct winsize w;
  if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &w) == 0) {
    return w.ws_col;
  }
#endif
  return 80;
}

// ─── Helper: format seconds as human-readable duration ───────────

inline std::string formatDuration(int seconds) {
  if (seconds < 60) return std::to_string(seconds) + "s";
  int m = seconds / 60;
  int s = seconds % 60;
  if (m < 60) return std::to_string(m) + "m " + std::to_string(s) + "s";
  int h = m / 60;
  m = m % 60;
  return std::to_string(h) + "h " + std::to_string(m) + "m";
}

// ─── Helper: render progress bar ─────────────────────────────────

inline void renderProgressBar(
    uint32_t done,
    uint32_t total,
    std::chrono::steady_clock::time_point stepStart) {
  if (total == 0) return;

  double fraction = static_cast<double>(done) / total;
  int percent = static_cast<int>(fraction * 100);

  // Calculate ETA
  auto now = std::chrono::steady_clock::now();
  double elapsed =
      std::chrono::duration<double>(now - stepStart).count();
  std::string eta;
  if (done > 0 && done < total) {
    double remaining = elapsed * (total - done) / done;
    eta = " ETA: " + formatDuration(static_cast<int>(remaining + 0.5));
  }

  // Build the bar: "  [████████░░░░░░░░] 50% ETA: 12s"
  int termWidth = getTerminalWidth();
  std::string prefix = "  [";
  std::string suffix = "] " + std::to_string(percent) + "%" + eta;
  int barWidth = termWidth - static_cast<int>(prefix.size() + suffix.size()) - 1;
  if (barWidth < 10) barWidth = 10;

  int filled = static_cast<int>(fraction * barWidth);
  if (filled > barWidth) filled = barWidth;

  std::string bar(filled, '#');
  bar += std::string(barWidth - filled, '-');

  std::cout << "\r" << color::dim() << prefix << color::reset()
            << color::green() << bar.substr(0, filled) << color::reset()
            << color::dim() << bar.substr(filled) << suffix
            << color::reset() << std::flush;
}

// ─── Helper: poll a background job until complete ────────────────

struct JobResult {
  std::string status;     // "completed" or "failed"
  nlohmann::json result;  // present when completed
  std::string error;      // present when failed
};

inline JobResult pollJob(DaemonClient& client, const std::string& jobId) {
  std::string lastStep;
  uint32_t lastDone = 0;
  auto stepStart = std::chrono::steady_clock::now();
  bool hadProgress = false;

  while (true) {
    nlohmann::json input = {{"jobId", jobId}};
    auto job = client.query("jobs.getStatus", input);

    std::string status = job.value("status", "");
    std::string currentStep = (job.contains("currentStep") && job["currentStep"].is_string())
                                  ? job["currentStep"].get<std::string>()
                                  : "";

    if (!currentStep.empty() && currentStep != lastStep) {
      if (hadProgress) {
        // Clear the progress line and move to next line
        renderProgressBar(1, 1, stepStart);
        std::cout << std::endl;
        hadProgress = false;
      }
      std::cout << color::dim() << "  " << currentStep << color::reset()
                << std::endl;
      lastStep = currentStep;
      lastDone = 0;
      stepStart = std::chrono::steady_clock::now();
    }

    // Read progress fields
    uint32_t progressTotal = 0;
    uint32_t progressDone = 0;
    if (job.contains("progress") && job["progress"].is_object()) {
      progressTotal = job["progress"].value("total", (uint32_t)0);
      progressDone = job["progress"].value("done", (uint32_t)0);
    }

    if (progressTotal > 0 && progressDone != lastDone) {
      lastDone = progressDone;
      hadProgress = true;
      renderProgressBar(progressDone, progressTotal, stepStart);
    }

    if (status == "completed") {
      if (hadProgress) {
        renderProgressBar(1, 1, stepStart);
        std::cout << std::endl;
      }
      return {status, job.value("result", nlohmann::json(nullptr)), ""};
    }
    if (status == "failed") {
      if (hadProgress) std::cout << std::endl;
      std::string errMsg = (job.contains("error") && job["error"].is_string())
                               ? job["error"].get<std::string>()
                               : "Unknown error";
      return {status, nullptr, errMsg};
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
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

  // Read CLI staging state
  auto stagedSet = readStagedFiles(ctx.root);

  // Categorize files
  std::vector<std::pair<std::string, FileStatus>> staged;
  std::vector<std::pair<std::string, FileStatus>> unstaged;

  for (auto& [path, file] : pending.files) {
    auto status = static_cast<FileStatus>(file.status);
    if (stagedSet.count(path)) {
      staged.push_back({path, status});
    } else {
      unstaged.push_back({path, status});
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
//  COMMAND: add (stage files)
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

  // Refresh to get current file statuses
  nlohmann::json refreshInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
  };
  auto refreshResult = client.query("workspaces.pending.refresh", refreshInput);

  std::vector<std::string> localPaths;
  std::vector<std::string> expandedPaths;

  if (!refreshResult.is_null()) {
    PendingChanges pending;
    from_json(refreshResult, pending);

    for (auto& p : resolvedPaths) {
      auto it = pending.files.find(p);
      if (it != pending.files.end()) {
        // Direct match in pending changes
        expandedPaths.push_back(p);
        auto status = static_cast<FileStatus>(it->second.status);
        if (status == FileStatus::Local) {
          localPaths.push_back(p);
        }
        continue;
      }

      // No direct match — try expanding as a directory prefix.
      // In a partially tracked directory, the daemon expands individual
      // files instead of collapsing it.  Treat the path as a glob to
      // find all pending children.  Fully untracked child directories
      // appear as single Directory/Local entries (no further recursion needed).
      std::string prefix = p;
      if (!prefix.empty() && prefix.back() != '/') {
        prefix += '/';
      }

      bool foundChildren = false;
      for (auto& [filePath, fileInfo] : pending.files) {
        if (filePath.compare(0, prefix.size(), prefix) == 0) {
          foundChildren = true;
          expandedPaths.push_back(filePath);
          auto status = static_cast<FileStatus>(fileInfo.status);
          if (status == FileStatus::Local) {
            localPaths.push_back(filePath);
          }
        }
      }

      if (foundChildren) {
        continue;
      }

      // Still no match — the file may live inside a collapsed untracked
      // directory.  Walk ancestor paths to detect this case.
      expandedPaths.push_back(p);
      std::string ancestor = p;
      while (true) {
        auto slash = ancestor.rfind('/');
        if (slash == std::string::npos) break;
        ancestor = ancestor.substr(0, slash);
        auto ait = pending.files.find(ancestor);
        if (ait != pending.files.end() &&
            static_cast<FileStatus>(ait->second.status) == FileStatus::Local &&
            static_cast<FileType>(ait->second.type) == FileType::Directory) {
          localPaths.push_back(p);
          break;
        }
      }
    }

    if (!localPaths.empty()) {
      nlohmann::json markInput = {
          {"daemonId", ws.daemonId},
          {"workspaceId", ws.id},
          {"paths", localPaths},
      };
      client.mutate("workspaces.pending.markForAdd", markInput);
    }
  } else {
    expandedPaths = resolvedPaths;
  }

  // Add expanded paths to CLI staged.json
  addStagedFiles(ctx.root, expandedPaths);

  for (auto& path : expandedPaths) {
    std::cout << color::green() << "  + " << path << color::reset() << std::endl;
  }
  std::cout << expandedPaths.size() << " file(s) staged." << std::endl;

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
    // For files that were Added (Local + markForAdd), tell daemon to unmarkForAdd
    nlohmann::json refreshInput = {
        {"daemonId", ws.daemonId},
        {"workspaceId", ws.id},
    };
    auto refreshResult = client.query("workspaces.pending.refresh", refreshInput);

    if (!refreshResult.is_null()) {
      PendingChanges pending;
      from_json(refreshResult, pending);

      std::vector<std::string> addedPaths;
      for (auto& path : resolvedPaths) {
        auto it = pending.files.find(path);
        if (it != pending.files.end()) {
          auto status = static_cast<FileStatus>(it->second.status);
          if (status == FileStatus::Added) {
            addedPaths.push_back(path);
          }
        }
      }

      if (!addedPaths.empty()) {
        nlohmann::json unmarkInput = {
            {"daemonId", ws.daemonId},
            {"workspaceId", ws.id},
            {"paths", addedPaths},
        };
        client.mutate("workspaces.pending.unmarkForAdd", unmarkInput);
      }
    }

    // Remove from CLI staged.json
    removeStagedFiles(ctx.root, resolvedPaths);

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

  // Read CLI staging state
  auto stagedSet = readStagedFiles(ctx.root);

  // Build modifications list from staged files
  nlohmann::json modifications = nlohmann::json::array();
  int stagedCount = 0;

  for (auto& [path, file] : pending.files) {
    if (!stagedSet.count(path)) continue;

    auto status = static_cast<FileStatus>(file.status);
    bool isDelete = (status == FileStatus::Deleted);
    modifications.push_back({
        {"path", path},
        {"delete", isDelete},
    });
    stagedCount++;
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
  };

  // Note: submit is a mutation in the daemon API (sends input as POST body)
  auto submitResult = client.mutate("workspaces.pending.submit", submitInput);

  std::string jobId = submitResult.value("jobId", "");
  if (jobId.empty()) {
    std::cerr << "error: No job ID returned from submit." << std::endl;
    return 1;
  }

  std::cout << "Submitting " << stagedCount << " file(s)..." << std::endl;

  auto jobResult = pollJob(client, jobId);

  if (jobResult.status == "failed") {
    std::cerr << color::red() << "error: " << jobResult.error
              << color::reset() << std::endl;
    return 1;
  }

  // Clear staged.json after successful submit
  writeStagedFiles(ctx.root, {});

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

  auto pullResult = client.mutate("workspaces.sync.pull", pullInput);

  std::string jobId = pullResult.value("jobId", "");
  if (jobId.empty()) {
    std::cerr << "error: No job ID returned from pull." << std::endl;
    return 1;
  }

  auto jobResult = pollJob(client, jobId);

  if (jobResult.status == "failed") {
    std::cerr << color::red() << "error: " << jobResult.error
              << color::reset() << std::endl;
    return 1;
  }

  std::cout << color::green() << color::bold()
            << "Pull complete." << color::reset() << std::endl;

  // Report merge results if any
  if (!jobResult.result.is_null()) {
    if (jobResult.result.contains("cleanMerges") && jobResult.result["cleanMerges"].is_array()) {
      auto& cleanMerges = jobResult.result["cleanMerges"];
      if (!cleanMerges.empty()) {
        std::cout << color::cyan() << cleanMerges.size()
                  << " file(s) auto-merged." << color::reset() << std::endl;
      }
    }
    if (jobResult.result.contains("conflictMerges") && jobResult.result["conflictMerges"].is_array()) {
      auto& conflictMerges = jobResult.result["conflictMerges"];
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
//  COMMAND: merge (merge a branch into the current branch)
// ═════════════════════════════════════════════════════════════════

inline int cmdMerge(const std::string& incomingBranch) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  std::cout << "Merging " << color::cyan() << incomingBranch
            << color::reset() << " into " << color::cyan() << ws.branchName
            << color::reset() << "..." << std::endl;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"incomingBranchName", incomingBranch},
  };

  auto result = client.mutate("workspaces.branches.merge", input);

  // Display merge result
  if (!result.is_null() && result.contains("mergeChangelist")) {
    auto& mc = result["mergeChangelist"];
    int clNumber = mc.value("number", -1);
    std::string msg = mc.value("message", "");

    // Show just the first line of the merge message
    auto firstNewline = msg.find('\n');
    if (firstNewline != std::string::npos) {
      msg = msg.substr(0, firstNewline);
    }

    std::cout << color::green() << color::bold()
              << "Merge complete." << color::reset() << std::endl;
    std::cout << "Created changelist #" << clNumber;
    if (!msg.empty()) {
      std::cout << ": " << msg;
    }
    std::cout << std::endl;

    if (result.contains("deletedBranch") && result["deletedBranch"].is_string()) {
      std::cout << color::dim() << "Branch '"
                << result["deletedBranch"].get<std::string>()
                << "' has been deleted." << color::reset() << std::endl;
    }
  } else {
    std::cout << color::green() << color::bold()
              << "Merge complete." << color::reset() << std::endl;
  }

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: log (show history)
// ═════════════════════════════════════════════════════════════════

// ─── Pager helper ────────────────────────────────────────────────

inline FILE* openPager(const std::string& output) {
#ifdef _WIN32
  // On Windows, check if stdout is a console handle
  HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
  if (hOut == INVALID_HANDLE_VALUE) return nullptr;
  DWORD mode;
  if (!GetConsoleMode(hOut, &mode)) return nullptr;
  // Check if output fits in the terminal — skip pager if so
  CONSOLE_SCREEN_BUFFER_INFO csbi;
  if (GetConsoleScreenBufferInfo(hOut, &csbi)) {
    int termHeight = csbi.srWindow.Bottom - csbi.srWindow.Top + 1;
    int lineCount = 1;
    for (char c : output) {
      if (c == '\n') lineCount++;
    }
    if (lineCount <= termHeight) return nullptr;
  }
  FILE* pager = _popen("less -FRX 2>nul || more", "w");
  return pager;
#else
  if (!isatty(fileno(stdout))) return nullptr;
  // Check if output fits in the terminal — skip pager if so
  struct winsize w;
  if (ioctl(fileno(stdout), TIOCGWINSZ, &w) == 0 && w.ws_row > 0) {
    int lineCount = 1;
    for (char c : output) {
      if (c == '\n') lineCount++;
    }
    if (lineCount <= static_cast<int>(w.ws_row)) return nullptr;
  }
  const char* pagerEnv = getenv("PAGER");
  std::string pagerCmd = pagerEnv ? pagerEnv : "less -FRX";
  FILE* pager = popen(pagerCmd.c_str(), "w");
  return pager;
#endif
}

inline void closePager(FILE* pager) {
  if (!pager) return;
#ifdef _WIN32
  _pclose(pager);
#else
  pclose(pager);
#endif
}

inline int cmdLog(int limit = 0) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  int count = (limit > 0) ? limit : 100;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"count", count},
  };

  auto result = client.query("workspaces.history.get", input);

  if (result.is_null() || !result.is_array() || result.empty()) {
    std::cout << "No history found." << std::endl;
    return 0;
  }

  // If a limit was explicitly set, truncate the result
  if (limit > 0 && static_cast<int>(result.size()) > limit) {
    result = nlohmann::json(
        std::vector<nlohmann::json>(result.begin(), result.begin() + limit));
  }

  // Build output string
  std::ostringstream out;
  for (auto& entry : result) {
    Changelist cl;
    from_json(entry, cl);

    out << color::yellow() << "changelist " << cl.number
        << color::reset() << "\n";

    std::string author;
    if (!cl.user.name.empty()) {
      author = cl.user.name;
    } else if (!cl.user.username.empty()) {
      author = cl.user.username;
    } else {
      author = cl.user.email;
    }

    if (!author.empty()) {
      out << "Author: " << author << "\n";
    }
    if (!cl.createdAt.empty()) {
      out << "Date:   " << cl.createdAt << "\n";
    }
    out << "\n";
    if (!cl.message.empty()) {
      out << "    " << cl.message << "\n";
    } else {
      out << "    " << color::dim() << "(no message)" << color::reset() << "\n";
    }
    out << "\n";
  }

  std::string output = out.str();

  // Page output if interactive TTY and output exceeds terminal height
  FILE* pager = openPager(output);
  if (pager) {
    fwrite(output.c_str(), 1, output.size(), pager);
    closePager(pager);
  } else {
    std::cout << output;
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
//  COMMAND: switch (switch to a different branch)
// ═════════════════════════════════════════════════════════════════

inline int cmdSwitch(const std::string& branchName) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  if (branchName == ws.branchName) {
    std::cout << "Already on branch '" << branchName << "'." << std::endl;
    return 0;
  }

  std::cout << "Switching to branch '" << branchName << "'..." << std::endl;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"branchName", branchName},
  };

  try {
    auto result = client.mutate("workspaces.branches.switch", input);

    std::string newBranch = result.value("branchName", branchName);
    std::cout << color::green() << color::bold()
              << "Switched to branch '" << newBranch << "'."
              << color::reset() << std::endl;
    return 0;
  } catch (std::exception& e) {
    std::string msg = e.what();
    // Surface the error message from the daemon
    try {
      auto errJson = nlohmann::json::parse(msg);
      if (errJson.contains("message")) {
        msg = errJson["message"].get<std::string>();
      }
    } catch (...) {
    }
    std::cerr << color::red() << "error: " << msg
              << color::reset() << std::endl;
    return 1;
  }
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
  if (usersResult.is_null() ||
      !usersResult.contains("users") ||
      !usersResult["users"].is_array() ||
      usersResult["users"].empty()) {
    std::cerr << color::red()
              << "error: not authenticated. Please sign in via the Checkpoint desktop app."
              << color::reset() << std::endl;
    return 1;
  }

  std::vector<User> users;
  for (auto& entry : usersResult["users"]) {
    User u;
    from_json(entry, u);
    users.push_back(u);
  }

  User user;
  if (users.size() == 1) {
    user = users[0];
  } else {
    // Multiple accounts — prompt user to select
    std::vector<std::string> userLabels;
    for (auto& u : users) {
      std::string label = u.name.empty() ? u.username : u.name;
      if (label.empty()) label = u.email;
      if (!u.email.empty() && label != u.email) {
        label += " <" + u.email + ">";
      }
      userLabels.push_back(label);
    }

    auto choice = interactiveSelect("Select an account:", userLabels);
    if (!choice.has_value()) {
      std::cout << "Cancelled." << std::endl;
      return 1;
    }
    user = users[choice.value()];
  }

  std::string daemonId = user.daemonId;

  if (daemonId.empty()) {
    std::cerr << color::red() << "error: could not determine daemon ID from auth."
              << color::reset() << std::endl;
    return 1;
  }

  // Fetch orgs
  nlohmann::json orgsInput = {{"daemonId", daemonId}};
  auto orgsResult = client.query("orgs.list", orgsInput);

  if (orgsResult.is_null() ||
      !orgsResult.contains("orgs") ||
      !orgsResult["orgs"].is_array() ||
      orgsResult["orgs"].empty()) {
    std::cerr << color::red()
              << "error: no organizations found. Create one in the Checkpoint web app first."
              << color::reset() << std::endl;
    return 1;
  }

  std::vector<Org> orgs;
  for (auto& entry : orgsResult["orgs"]) {
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

// ═════════════════════════════════════════════════════════════════
//  COMMAND: accounts (list authenticated accounts)
// ═════════════════════════════════════════════════════════════════

inline int cmdAccounts() {
  int port = getDaemonPort();
  std::string baseUrl = "http://127.0.0.1:" + std::to_string(port);
  DaemonClient client(baseUrl);

  auto usersResult = client.query("auth.getUsers");
  if (usersResult.is_null() ||
      !usersResult.contains("users") ||
      !usersResult["users"].is_array() ||
      usersResult["users"].empty()) {
    std::cout << "No authenticated accounts." << std::endl;
    std::cout << color::dim() << "  (use \"chk login\" to sign in)"
              << color::reset() << std::endl;
    return 0;
  }

  auto& users = usersResult["users"];
  std::cout << color::bold() << "Authenticated accounts:"
            << color::reset() << std::endl;
  std::cout << std::endl;

  for (auto& entry : users) {
    User user;
    from_json(entry, user);

    std::string displayName = user.name.empty() ? user.username : user.name;
    if (displayName.empty()) {
      displayName = user.email;
    }

    std::cout << "  " << color::green() << displayName << color::reset();
    if (!user.email.empty() && displayName != user.email) {
      std::cout << color::dim() << " <" << user.email << ">" << color::reset();
    }
    std::cout << std::endl;

    std::cout << "    " << color::dim() << "ID:       " << user.id << color::reset() << std::endl;
    std::cout << "    " << color::dim() << "Daemon:   " << user.daemonId << color::reset() << std::endl;
    std::cout << "    " << color::dim() << "Endpoint: " << user.endpoint << color::reset() << std::endl;
    std::cout << std::endl;
  }

  std::cout << users.size() << " account(s) total." << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: login (authenticate with a Checkpoint server)
// ═════════════════════════════════════════════════════════════════

inline int cmdLogin(const std::string& endpoint, const std::string& daemonId) {
  int port = getDaemonPort();
  std::string baseUrl = "http://127.0.0.1:" + std::to_string(port);
  DaemonClient client(baseUrl);

  std::cout << "Authenticating with " << color::bold() << endpoint
            << color::reset() << "..." << std::endl;

  // Call auth.login on the daemon — this returns { code, url } immediately
  // and the daemon opens the browser + polls for authorization in the background
  nlohmann::json loginInput = {
      {"endpoint", endpoint},
      {"daemonId", daemonId},
  };

  nlohmann::json loginResult;
  try {
    loginResult = client.mutate("auth.login", loginInput);
  } catch (const std::exception& e) {
    std::cerr << color::red() << "error: failed to start login: " << e.what()
              << color::reset() << std::endl;
    return 1;
  }

  std::string code = loginResult.value("code", "");
  std::string url = loginResult.value("url", "");

  if (code.empty() || url.empty()) {
    std::cerr << color::red() << "error: daemon returned invalid login response."
              << color::reset() << std::endl;
    return 1;
  }

  std::cout << std::endl;
  std::cout << "A browser window should have opened. If not, open this URL:" << std::endl;
  std::cout << std::endl;
  std::cout << "  " << color::cyan() << color::bold() << url << color::reset() << std::endl;
  std::cout << std::endl;
  std::cout << "Your device code is: " << color::yellow() << color::bold()
            << code << color::reset() << std::endl;
  std::cout << std::endl;
  std::cout << "Waiting for authorization..." << std::flush;

  // Poll auth.getUser until the daemon has the token
  nlohmann::json getUserInput = {{"daemonId", daemonId}};
  constexpr int maxAttempts = 5 * 60;  // 5 minutes at 1 second intervals

  for (int i = 0; i < maxAttempts; i++) {
    std::this_thread::sleep_for(std::chrono::seconds(1));

    try {
      auto userResult = client.query("auth.getUser", getUserInput);
      if (!userResult.is_null() && userResult.contains("user")) {
        auto& u = userResult["user"];
        std::string name = jsonStr(u, "name");
        std::string email = jsonStr(u, "email");
        std::string username = jsonStr(u, "username");

        std::string displayName = name.empty() ? username : name;
        if (displayName.empty()) {
          displayName = email;
        }

        std::cout << std::endl
                  << std::endl;
        std::cout << color::green() << color::bold()
                  << "Authenticated successfully!" << color::reset() << std::endl;
        std::cout << color::dim() << "  Signed in as: " << displayName;
        if (!email.empty() && displayName != email) {
          std::cout << " <" << email << ">";
        }
        std::cout << color::reset() << std::endl;
        std::cout << color::dim() << "  Daemon ID:    " << daemonId
                  << color::reset() << std::endl;

        return 0;
      }
    } catch (...) {
      // Not yet authorized — keep polling
    }

    // Print a dot every 5 seconds to show progress
    if (i % 5 == 4) {
      std::cout << "." << std::flush;
    }
  }

  std::cout << std::endl;
  std::cerr << color::red()
            << "error: timed out waiting for authorization (5 minutes)."
            << color::reset() << std::endl;
  return 1;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: logout (remove authentication for a Checkpoint server)
// ═════════════════════════════════════════════════════════════════

inline int cmdLogout() {
  int port = getDaemonPort();
  std::string baseUrl = "http://127.0.0.1:" + std::to_string(port);
  DaemonClient client(baseUrl);

  auto usersResult = client.query("auth.getUsers");
  if (usersResult.is_null() ||
      !usersResult.contains("users") ||
      !usersResult["users"].is_array() ||
      usersResult["users"].empty()) {
    std::cout << "No authenticated accounts." << std::endl;
    std::cout << color::dim() << "  (use \"chk login\" to sign in)"
              << color::reset() << std::endl;
    return 0;
  }

  // Interactive account selection
  auto& users = usersResult["users"];
  std::vector<std::string> endpoints;
  for (auto& user : users) {
    endpoints.push_back(user["endpoint"].get<std::string>());
  }

  auto endpointChoice = interactiveSelect("Select an account to log out:", endpoints);
  if (!endpointChoice.has_value()) {
    std::cout << "Cancelled." << std::endl;
    return 1;
  }

  auto& chosenEndpoint = endpoints[endpointChoice.value()];

  for (auto& user : users) {
    if (user["endpoint"].get<std::string>() == chosenEndpoint) {
      std::string daemonId = user.value("daemonId", "");
      if (!daemonId.empty()) {
        nlohmann::json logoutInput = {{"daemonId", daemonId}};
        client.mutate("auth.logout", logoutInput);
        std::cout << color::green() << "Logged out of " << chosenEndpoint
                  << color::reset() << std::endl;
        return 0;
      }
    }
  }

  std::cerr << color::red() << "error: failed to find daemon ID for selected account."
            << color::reset() << std::endl;

  return 1;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: shelve (shelve staged files)
// ═════════════════════════════════════════════════════════════════

inline int cmdShelve(const std::string& name, const std::string& message) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  // Refresh to get current pending changes
  nlohmann::json refreshInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
  };

  auto refreshResult = client.query("workspaces.pending.refresh", refreshInput);

  if (refreshResult.is_null()) {
    std::cerr << "No pending changes to shelve." << std::endl;
    return 1;
  }

  PendingChanges pending;
  from_json(refreshResult, pending);

  auto stagedSet = readStagedFiles(ctx.root);

  nlohmann::json modifications = nlohmann::json::array();
  int stagedCount = 0;

  for (auto& [path, file] : pending.files) {
    if (!stagedSet.count(path)) continue;

    auto status = static_cast<FileStatus>(file.status);
    bool isDelete = (status == FileStatus::Deleted);
    modifications.push_back({
        {"path", path},
        {"delete", isDelete},
    });
    stagedCount++;
  }

  if (stagedCount == 0) {
    std::cerr << "No staged changes to shelve." << std::endl;
    std::cerr << color::dim() << "  (use \"chk add <file>\" to stage files)"
              << color::reset() << std::endl;
    return 1;
  }

  std::string submitMessage = message.empty() ? ("Shelf: " + name) : message;

  nlohmann::json submitInput = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"message", submitMessage},
      {"modifications", modifications},
      {"shelfName", name},
  };

  auto submitResult = client.mutate("workspaces.pending.submit", submitInput);

  std::string jobId = submitResult.value("jobId", "");
  if (jobId.empty()) {
    std::cerr << "error: No job ID returned from shelve." << std::endl;
    return 1;
  }

  std::cout << "Shelving " << stagedCount << " file(s) to '" << name << "'..." << std::endl;

  auto jobResult = pollJob(client, jobId);

  if (jobResult.status == "failed") {
    std::cerr << color::red() << "error: " << jobResult.error
              << color::reset() << std::endl;
    return 1;
  }

  // Clear staged.json after successful shelve
  writeStagedFiles(ctx.root, {});

  std::cout << color::green() << color::bold()
            << "Successfully shelved " << stagedCount << " file(s) to '" << name << "'."
            << color::reset() << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: shelf list
// ═════════════════════════════════════════════════════════════════

inline int cmdShelfList() {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"status", "ACTIVE"},
  };

  auto result = client.query("workspaces.shelves.list", input);

  if (result.is_null() || !result.is_array() || result.empty()) {
    std::cout << "No active shelves." << std::endl;
    return 0;
  }

  for (auto& shelf : result) {
    std::string name = shelf.value("name", "");
    std::string status = shelf.value("status", "");
    int clNum = shelf.value("changelistNumber", 0);
    std::string desc = shelf.value("description", "");

    // Get file count from _count
    int fileCount = 0;
    if (shelf.contains("_count") && shelf["_count"].contains("fileChanges")) {
      fileCount = shelf["_count"]["fileChanges"].get<int>();
    }

    // Get author name
    std::string authorName;
    if (shelf.contains("author")) {
      authorName = shelf["author"].value("name", shelf["author"].value("email", "unknown"));
    }

    std::cout << color::green() << "  " << name << color::reset();
    std::cout << color::dim() << " (CL #" << clNum
              << ", " << fileCount << " file" << (fileCount != 1 ? "s" : "")
              << ", by " << authorName << ")";
    if (!desc.empty()) {
      std::cout << " — " << desc;
    }
    std::cout << color::reset() << std::endl;
  }

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: shelf delete
// ═════════════════════════════════════════════════════════════════

inline int cmdShelfDelete(const std::string& name) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"name", name},
  };

  client.mutate("workspaces.shelves.delete", input);

  std::cout << color::green() << "Deleted shelf '" << name << "'."
            << color::reset() << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: unshelve (apply shelf to workspace)
// ═════════════════════════════════════════════════════════════════

inline int cmdUnshelve(const std::string& name, const std::string& branchName) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  std::string targetBranch = branchName.empty() ? ws.branchName : branchName;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"shelfName", name},
      {"branchName", targetBranch},
  };

  auto result = client.mutate("workspaces.shelves.submitToBranch", input);

  int clNum = 0;
  if (!result.is_null() && result.contains("changelistNumber")) {
    clNum = result["changelistNumber"].get<int>();
  }

  std::cout << color::green() << color::bold()
            << "Shelf '" << name << "' submitted to branch '" << targetBranch << "'";
  if (clNum > 0) {
    std::cout << " as CL #" << clNum;
  }
  std::cout << "." << color::reset() << std::endl;

  std::cout << color::dim() << "Run 'chk pull' to sync the changes to your workspace."
            << color::reset() << std::endl;

  return 0;
}

// ═════════════════════════════════════════════════════════════════
//  COMMAND: artifact upload
// ═════════════════════════════════════════════════════════════════

inline int cmdArtifactUpload(int changelistNumber, const std::vector<std::string>& files, const std::string& message) {
  auto ctx = getWorkspaceContext();
  auto& client = ctx.client;
  auto& ws = ctx.workspace;

  if (files.empty()) {
    std::cerr << "No files specified for artifact upload." << std::endl;
    std::cerr << color::dim() << "  Usage: chk artifact upload <cl-number> <file1> [file2] ..."
              << color::reset() << std::endl;
    return 1;
  }

  nlohmann::json modifications = nlohmann::json::array();
  for (const auto& filePath : files) {
    // Normalize path relative to workspace root
    auto absPath = fs::absolute(filePath);
    auto relPath = fs::relative(absPath, ctx.root);
    std::string relStr = relPath.generic_string();

    if (!fs::exists(absPath)) {
      std::cerr << color::red() << "error: File not found: " << filePath
                << color::reset() << std::endl;
      return 1;
    }

    modifications.push_back({
        {"path", relStr},
        {"delete", false},
    });
  }

  std::string submitMessage = message.empty()
                                  ? ("Artifact upload for CL #" + std::to_string(changelistNumber))
                                  : message;

  nlohmann::json input = {
      {"daemonId", ws.daemonId},
      {"workspaceId", ws.id},
      {"changelistNumber", changelistNumber},
      {"modifications", modifications},
      {"message", submitMessage},
  };

  auto result = client.mutate("workspaces.artifacts.upload", input);

  std::string jobId = result.value("jobId", "");
  if (jobId.empty()) {
    std::cerr << "error: No job ID returned from artifact upload." << std::endl;
    return 1;
  }

  std::cout << "Uploading " << files.size() << " artifact(s) for CL #"
            << changelistNumber << "..." << std::endl;

  auto jobResult = pollJob(client, jobId);

  if (jobResult.status == "failed") {
    std::cerr << color::red() << "error: " << jobResult.error
              << color::reset() << std::endl;
    return 1;
  }

  std::cout << color::green() << color::bold()
            << "Successfully uploaded " << files.size() << " artifact(s) for CL #"
            << changelistNumber << "."
            << color::reset() << std::endl;

  return 0;
}

/**
 * chk unlink — Interactively select a workspace to unlink from the daemon.
 * Stops watching and removes from daemon.json, but does NOT delete .checkpoint.
 */
inline int cmdUnlink() {
  // Connect to daemon
  int port = getDaemonPort();
  std::string baseUrl = "http://127.0.0.1:" + std::to_string(port);
  DaemonClient client(baseUrl);

  // Get authenticated users
  auto usersResult = client.query("auth.getUsers");
  if (usersResult.is_null() ||
      !usersResult.contains("users") ||
      !usersResult["users"].is_array() ||
      usersResult["users"].empty()) {
    std::cerr << color::red()
              << "error: not authenticated. Please sign in via the Checkpoint desktop app."
              << color::reset() << std::endl;
    return 1;
  }

  std::vector<User> users;
  for (auto& entry : usersResult["users"]) {
    User u;
    from_json(entry, u);
    users.push_back(u);
  }

  User user;
  if (users.size() == 1) {
    user = users[0];
  } else {
    std::vector<std::string> userLabels;
    for (auto& u : users) {
      std::string label = u.name.empty() ? u.username : u.name;
      if (label.empty()) label = u.email;
      if (!u.email.empty() && label != u.email) {
        label += " <" + u.email + ">";
      }
      userLabels.push_back(label);
    }

    auto choice = interactiveSelect("Select an account:", userLabels);
    if (!choice.has_value()) {
      std::cout << "Cancelled." << std::endl;
      return 1;
    }
    user = users[choice.value()];
  }

  std::string daemonId = user.daemonId;

  // Fetch local workspaces for this daemon
  nlohmann::json listInput = {{"daemonId", daemonId}};
  auto wsResult = client.query("workspaces.ops.list.local", listInput);

  if (wsResult.is_null() ||
      !wsResult.contains("workspaces") ||
      !wsResult["workspaces"].is_array() ||
      wsResult["workspaces"].empty()) {
    std::cout << "No linked workspaces found." << std::endl;
    return 0;
  }

  struct WorkspaceEntry {
    std::string id;
    std::string name;
    std::string localPath;
    std::string branchName;
  };

  std::vector<WorkspaceEntry> workspaces;
  for (auto& entry : wsResult["workspaces"]) {
    WorkspaceEntry ws;
    ws.id = entry.value("id", "");
    ws.name = entry.value("name", "");
    ws.localPath = entry.value("localPath", "");
    ws.branchName = entry.value("branchName", "");
    workspaces.push_back(ws);
  }

  // Build display labels
  std::vector<std::string> labels;
  for (auto& ws : workspaces) {
    std::string label = ws.localPath;
    if (!ws.branchName.empty()) {
      label += " (" + ws.branchName + ")";
    }
    labels.push_back(label);
  }

  auto choice = interactiveSelect("Select a workspace to unlink:", labels);
  if (!choice.has_value()) {
    std::cout << "Cancelled." << std::endl;
    return 0;
  }

  auto& selected = workspaces[choice.value()];

  // Call daemon to unlink
  nlohmann::json removeInput = {
      {"daemonId", daemonId},
      {"workspaceId", selected.id},
  };
  client.mutate("workspaces.ops.remove", removeInput);

  std::cout << color::green() << "Workspace unlinked: " << color::reset()
            << selected.localPath << std::endl;
  std::cout << color::dim()
            << "The .checkpoint directory was preserved. Run 'chk init' to re-link."
            << color::reset() << std::endl;

  return 0;
}

}  // namespace checkpoint
