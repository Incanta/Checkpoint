#include <filesystem>
#include <string>

#include "main.h"

namespace fs = std::filesystem;

bool Checkpoint::TryAcquireLock(Checkpoint::Workspace* workspace) {
  if (workspace == nullptr || workspace->localRoot == nullptr || strlen(workspace->localRoot) == 0) {
    return false;
  }

  fs::path lockFilePath = fs::path(workspace->localRoot) / ".checkpoint" / "lock";

  std::ofstream lockFile(lockFilePath);
  if (!lockFile.is_open()) {
    return false;
  }

  lockFile.close();
  return true;
}

bool Checkpoint::AcquireLock(Checkpoint::Workspace* workspace) {
  if (workspace == nullptr || workspace->localRoot == nullptr || strlen(workspace->localRoot) == 0) {
    return false;
  }

  fs::path lockFilePath = fs::path(workspace->localRoot) / ".checkpoint" / "lock";

  // Try to create the lock file
  std::ofstream lockFile(lockFilePath);

  while (!lockFile.is_open()) {
    // Wait for a short period before retrying
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    lockFile.open(lockFilePath);
  }

  lockFile.close();
  return true;
}

void Checkpoint::ReleaseLock(Checkpoint::Workspace* workspace) {
  if (workspace == nullptr || workspace->localRoot == nullptr || strlen(workspace->localRoot) == 0) {
    return;
  }

  fs::path lockFilePath = fs::path(workspace->localRoot) / ".checkpoint" / "lock";

  if (fs::exists(lockFilePath)) {
    fs::remove(lockFilePath);
  }
}
