#pragma once

#include <chrono>
#include <set>
#include <string>

#include "json.h"

struct WorkspaceStateDiff {
  std::time_t timestamp;
  std::set<std::string> deletions;
  std::set<uint32_t> changelistsToPull;
};

WorkspaceStateDiff GetWorkspaceStateDiff(json state, json newState);
