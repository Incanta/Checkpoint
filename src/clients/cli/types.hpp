#pragma once

#include <cstdint>
#include <map>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace checkpoint {

// ─── FileType ────────────────────────────────────────────────────

enum class FileType : int {
  Unknown = 0,
  Directory = 1,
  Text = 2,
  Binary = 3,
  Symlink = 4,
};

// ─── FileStatus ──────────────────────────────────────────────────

enum class FileStatus : int {
  Unknown = 0,
  NotInWorkspaceRoot = 1,
  Local = 2,
  Added = 3,
  Renamed = 4,
  Deleted = 5,
  Ignored = 6,
  HiddenChanges = 7,
  ReadOnlyControlled = 8,
  WritableControlled = 9,
  ChangedNotCheckedOut = 10,
  ChangedCheckedOut = 11,
  NotChangedCheckedOut = 12,
  Conflicted = 13,
  Artifact = 14,
  MergeConflict = 15,
};

inline std::string fileStatusToString(FileStatus status) {
  switch (status) {
    case FileStatus::Unknown:
      return "unknown";
    case FileStatus::NotInWorkspaceRoot:
      return "not in workspace";
    case FileStatus::Local:
      return "local (untracked)";
    case FileStatus::Added:
      return "added (staged)";
    case FileStatus::Renamed:
      return "renamed";
    case FileStatus::Deleted:
      return "deleted";
    case FileStatus::Ignored:
      return "ignored";
    case FileStatus::HiddenChanges:
      return "hidden";
    case FileStatus::ReadOnlyControlled:
      return "controlled (read-only)";
    case FileStatus::WritableControlled:
      return "controlled (writable)";
    case FileStatus::ChangedNotCheckedOut:
      return "modified (not checked out)";
    case FileStatus::ChangedCheckedOut:
      return "modified (checked out)";
    case FileStatus::NotChangedCheckedOut:
      return "checked out (unchanged)";
    case FileStatus::Conflicted:
      return "conflicted";
    case FileStatus::Artifact:
      return "artifact";
    case FileStatus::MergeConflict:
      return "merge conflict";
    default:
      return "unknown";
  }
}

inline std::string fileStatusSymbol(FileStatus status) {
  switch (status) {
    case FileStatus::Local:
      return "?";
    case FileStatus::Added:
      return "+";
    case FileStatus::Renamed:
      return "R";
    case FileStatus::Deleted:
      return "D";
    case FileStatus::ChangedNotCheckedOut:
      return "M";
    case FileStatus::ChangedCheckedOut:
      return "M";
    case FileStatus::NotChangedCheckedOut:
      return "C";
    case FileStatus::Conflicted:
      return "!";
    case FileStatus::MergeConflict:
      return "!";
    default:
      return " ";
  }
}

// ─── File ────────────────────────────────────────────────────────

struct FileInfo {
  std::string path;
  int type = 0;
  int64_t size = 0;
  double modifiedAt = 0;
  int status = 0;
  std::string id;
  int changelist = 0;
};

inline void from_json(const nlohmann::json& j, FileInfo& f) {
  f.path = j.value("path", "");
  f.type = j.value("type", 0);
  f.size = j.value("size", (int64_t)0);
  f.modifiedAt = j.value("modifiedAt", 0.0);
  f.status = j.value("status", 0);
  if (j.contains("id") && !j["id"].is_null()) {
    f.id = j["id"].get<std::string>();
  }
  if (j.contains("changelist") && !j["changelist"].is_null()) {
    f.changelist = j["changelist"].get<int>();
  }
}

// ─── PendingChanges ──────────────────────────────────────────────

struct PendingChanges {
  int numChanges = 0;
  std::map<std::string, FileInfo> files;
};

inline void from_json(const nlohmann::json& j, PendingChanges& pc) {
  pc.numChanges = j.value("numChanges", 0);
  if (j.contains("files") && j["files"].is_object()) {
    for (auto& [key, val] : j["files"].items()) {
      FileInfo fi;
      from_json(val, fi);
      pc.files[key] = fi;
    }
  }
}

// ─── Workspace ───────────────────────────────────────────────────

struct WorkspaceConfig {
  std::string id;
  std::string repoId;
  std::string branchName;
  std::string workspaceName;
  std::string localPath;
  std::string daemonId;
};

inline void from_json(const nlohmann::json& j, WorkspaceConfig& ws) {
  ws.id = j.value("id", "");
  ws.repoId = j.value("repoId", "");
  ws.branchName = j.value("branchName", "");
  ws.workspaceName = j.value("workspaceName", "");
  ws.localPath = j.value("localPath", "");
  ws.daemonId = j.value("daemonId", "");
}

// ─── Changelist (history entry) ──────────────────────────────────

struct Changelist {
  int number = 0;
  std::string message;
  std::string createdAt;
  int parentNumber = 0;
  struct {
    std::string email;
    std::string name;
    std::string username;
  } user;
};

inline void from_json(const nlohmann::json& j, Changelist& cl) {
  cl.number = j.value("number", 0);
  cl.message = j.value("message", "");
  cl.createdAt = j.value("createdAt", "");
  if (j.contains("parentNumber") && !j["parentNumber"].is_null()) {
    cl.parentNumber = j["parentNumber"].get<int>();
  }
  if (j.contains("user") && j["user"].is_object()) {
    auto& u = j["user"];
    cl.user.email = u.value("email", "");
    cl.user.name = u.value("name", "");
    cl.user.username = u.value("username", "");
  }
}

// ─── Branch ──────────────────────────────────────────────────────

struct Branch {
  std::string name;
  std::string type;
  bool archived = false;
  int headNumber = 0;
  std::string parentBranchName;
};

inline void from_json(const nlohmann::json& j, Branch& b) {
  b.name = j.value("name", "");
  b.type = j.value("type", "");
  b.archived = j.value("archived", false);
  b.headNumber = j.value("headNumber", 0);
  if (j.contains("parentBranchName") && !j["parentBranchName"].is_null()) {
    b.parentBranchName = j["parentBranchName"].get<std::string>();
  }
}

// ─── SyncStatus ──────────────────────────────────────────────────

struct SyncStatus {
  bool upToDate = true;
  int localChangelistNumber = 0;
  int remoteHeadNumber = 0;
  int changelistsBehind = 0;
  std::vector<int> changelistsToPull;
  std::string checkedAt;
};

inline void from_json(const nlohmann::json& j, SyncStatus& ss) {
  ss.upToDate = j.value("upToDate", true);
  ss.localChangelistNumber = j.value("localChangelistNumber", 0);
  ss.remoteHeadNumber = j.value("remoteHeadNumber", 0);
  ss.changelistsBehind = j.value("changelistsBehind", 0);
  if (j.contains("changelistsToPull") && j["changelistsToPull"].is_array()) {
    ss.changelistsToPull = j["changelistsToPull"].get<std::vector<int>>();
  }
  ss.checkedAt = j.value("checkedAt", "");
}

// ─── Helpers ─────────────────────────────────────────────────────

// Safely get a string from JSON, returning defaultVal for missing or null keys.
inline std::string jsonStr(const nlohmann::json& j, const char* key, const std::string& defaultVal = "") {
  if (j.contains(key) && j[key].is_string()) {
    return j[key].get<std::string>();
  }
  return defaultVal;
}

// ─── User ────────────────────────────────────────────────────────

struct User {
  std::string id;
  std::string email;
  std::string name;
  std::string username;
  std::string daemonId;
  std::string endpoint;
};

inline void from_json(const nlohmann::json& j, User& u) {
  u.id = jsonStr(j, "id");
  u.email = jsonStr(j, "email");
  u.name = jsonStr(j, "name");
  u.username = jsonStr(j, "username");
  u.daemonId = jsonStr(j, "daemonId");
  u.endpoint = jsonStr(j, "endpoint");
}

// ─── Org ─────────────────────────────────────────────────────────

struct OrgRepoSummary {
  std::string id;
  std::string name;
};

inline void from_json(const nlohmann::json& j, OrgRepoSummary& r) {
  r.id = j.value("id", "");
  r.name = j.value("name", "");
}

struct Org {
  std::string id;
  std::string name;
  std::vector<OrgRepoSummary> repos;
};

inline void from_json(const nlohmann::json& j, Org& o) {
  o.id = j.value("id", "");
  o.name = j.value("name", "");
  if (j.contains("repos") && j["repos"].is_array()) {
    for (auto& entry : j["repos"]) {
      OrgRepoSummary r;
      from_json(entry, r);
      o.repos.push_back(r);
    }
  }
}

// ─── Repo ────────────────────────────────────────────────────────

struct Repo {
  std::string id;
  std::string name;
  std::string orgId;
  bool isPublic = false;
};

inline void from_json(const nlohmann::json& j, Repo& r) {
  r.id = j.value("id", "");
  r.name = j.value("name", "");
  r.orgId = j.value("orgId", "");
  r.isPublic = j.value("public", false);
}

}  // namespace checkpoint
