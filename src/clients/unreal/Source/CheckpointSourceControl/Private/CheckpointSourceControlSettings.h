// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

/**
 * Settings for the Checkpoint source control provider.
 *
 * Instead of asking users for manual input, we auto-detect configuration
 * from two JSON files:
 *
 *  1. `$HOME/.checkpoint/daemon.json`
 *       - `daemonPort`  — the port the local daemon listens on
 *       - `workspaces[]` — array of workspace objects; each has
 *         `daemonId` and we also extract `userId` from here
 *
 *  2. `<ProjectDir>/.checkpoint/workspace.json`  (searches ancestors)
 *       - `id`        — workspace ID
 *       - `daemonId`  — identifies the account / daemon identity
 *       - `localPath` — workspace root
 *       - `name`      — workspace name
 *       - `repoId`    — repository ID
 *       - `orgId`     — organization ID
 *       - `branchName`— current branch
 */
class FCheckpointSourceControlSettings {
public:
  FCheckpointSourceControlSettings();

  /**
   * Try to load settings from JSON config files.
   * Returns true if all essential fields were resolved.
   */
  bool LoadFromConfigFiles();

  /** Get the daemon port */
  int32 GetDaemonPort() const {
    return DaemonPort;
  }

  /** Get the daemon ID (user identity) */
  const FString &GetDaemonId() const {
    return DaemonId;
  }

  /** Get the workspace ID */
  const FString &GetWorkspaceId() const {
    return WorkspaceId;
  }

  /** Get the workspace local path */
  const FString &GetWorkspacePath() const {
    return WorkspacePath;
  }

  /** Get the workspace name */
  const FString &GetWorkspaceName() const {
    return WorkspaceName;
  }

  /** Get the repo ID */
  const FString &GetRepoId() const {
    return RepoId;
  }

  /** Get the org ID */
  const FString &GetOrgId() const {
    return OrgId;
  }

  /** Get the branch name */
  const FString &GetBranchName() const {
    return BranchName;
  }

  /** Get the full daemon URL */
  FString GetDaemonUrl() const;

  /** Whether auto-detection succeeded */
  bool IsConfigured() const {
    return bConfigured;
  }

  /**
   * Walk from StartDir upward looking for `.checkpoint/workspace.json`.
   * Returns empty string if not found.
   */
  static FString FindWorkspaceJson(const FString &StartDir);

  /**
   * Parse a JSON file at the given path.
   * Returns nullptr if file cannot be read or parsed.
   */
  static TSharedPtr<FJsonObject> ReadJsonFile(const FString &FilePath);

private:
  /** Port the Checkpoint daemon listens on */
  int32 DaemonPort;

  /** The daemon identity to use */
  FString DaemonId;

  /** The workspace ID to operate on */
  FString WorkspaceId;

  /** The local path of the workspace root */
  FString WorkspacePath;

  /** Display name of the workspace */
  FString WorkspaceName;

  /** Repository ID */
  FString RepoId;

  /** Organization ID */
  FString OrgId;

  /** Branch name */
  FString BranchName;

  /** Whether all settings were resolved successfully */
  bool bConfigured;
};
