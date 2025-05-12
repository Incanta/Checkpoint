#include "diff.h"

WorkspaceStateDiff GetWorkspaceStateDiff(json state, json newState) {
  WorkspaceStateDiff diff;
  diff.timestamp = std::time(nullptr);

  for (const auto& [stateFileId, stateFileValue] : state.items()) {
    if (!newState.contains(stateFileId)) {
      diff.deletions.insert(stateFileId);

    } else if (stateFileValue != newState[stateFileId]) {
      diff.changelistsToPull.insert(newState[stateFileId].get<uint32_t>());
    }
  }

  for (const auto& [newStateFileId, newStateFileValue] : newState.items()) {
    if (!state.contains(newStateFileId)) {
      diff.changelistsToPull.insert(newStateFileValue.get<uint32_t>());
    }
  }

  return diff;
}
