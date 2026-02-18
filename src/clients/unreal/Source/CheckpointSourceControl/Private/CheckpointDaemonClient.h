// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

/**
 * HTTP client for communicating with the Checkpoint daemon's tRPC API.
 * The daemon runs locally and exposes a tRPC HTTP server with superjson
 * transformer.
 */
class FCheckpointDaemonClient {
public:
  FCheckpointDaemonClient();

  /** Set the base daemon URL (e.g. http://127.0.0.1:3010) */
  void SetDaemonUrl(const FString &InUrl);

  /**
   * Call a tRPC query procedure (HTTP GET).
   * @param Path       Dot-separated procedure path (e.g. "auth.getUser")
   * @param Input      Input JSON object (will be wrapped in {"json": ...})
   * @param OutResult  Parsed result data from response
   * @param OutError   Error message if call failed
   * @return true on success
   */
  bool QueryProcedure(
    const FString &Path,
    const TSharedPtr<FJsonObject> &Input,
    TSharedPtr<FJsonObject> &OutResult,
    FString &OutError
  );

  /**
   * Call a tRPC mutation procedure (HTTP POST).
   */
  bool MutateProcedure(
    const FString &Path,
    const TSharedPtr<FJsonObject> &Input,
    TSharedPtr<FJsonObject> &OutResult,
    FString &OutError
  );

  // ---- High-level API methods ----

  /** Get all logged-in users from the daemon */
  bool GetUsers(TArray<TSharedPtr<FJsonValue>> &OutUsers, FString &OutError);

  /** Get the authenticated user for a daemon ID */
  bool GetUser(
    const FString &DaemonId, TSharedPtr<FJsonObject> &OutUser, FString &OutError
  );

  /** List locally tracked workspaces */
  bool GetLocalWorkspaces(
    const FString &DaemonId,
    TArray<TSharedPtr<FJsonValue>> &OutWorkspaces,
    FString &OutError
  );

  /** Get directory contents with file statuses */
  bool GetDirectory(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const FString &RelPath,
    TSharedPtr<FJsonObject> &OutDirectory,
    FString &OutError
  );

  /** Get active checkouts for files */
  bool GetActiveCheckouts(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const TArray<FString> &RelPaths,
    TArray<TSharedPtr<FJsonValue>> &OutCheckouts,
    FString &OutError
  );

  /** Check out a file */
  bool Checkout(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const FString &RelPath,
    bool bLocked,
    FString &OutError
  );

  /** Undo a file checkout */
  bool UndoCheckout(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const FString &RelPath,
    FString &OutError
  );

  /** Submit pending changes */
  bool Submit(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const FString &Message,
    const TArray<TSharedPtr<FJsonValue>> &Modifications,
    bool bShelved,
    bool bKeepCheckedOut,
    FString &OutError
  );

  /** Pull/sync workspace to latest */
  bool Pull(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const TArray<FString> *FilePaths,
    FString &OutError
  );

  /** Get changelist history */
  bool GetHistory(
    const FString &DaemonId,
    const FString &WorkspaceId,
    TArray<TSharedPtr<FJsonValue>> &OutHistory,
    FString &OutError
  );

  /** Get file-specific history */
  bool GetFileHistory(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const FString &RelPath,
    TArray<TSharedPtr<FJsonValue>> &OutHistory,
    FString &OutError
  );

  /** Diff a file against head version */
  bool DiffFile(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const FString &RelPath,
    FString &OutLeft,
    FString &OutRight,
    FString &OutError
  );

  /** Refresh workspace state */
  bool RefreshWorkspace(
    const FString &DaemonId, const FString &WorkspaceId, FString &OutError
  );

  /**
   * Refresh workspace and get all pending changes.
   * Returns file paths (relative) mapped to their status int.
   */
  bool GetPendingChanges(
    const FString &DaemonId,
    const FString &WorkspaceId,
    TMap<FString, int32> &OutFileStatuses,
    FString &OutError
  );

  /**
   * Get a historical file cached on disk via fileHistoryDiff.
   * Returns the local cache path and whether the file is binary.
   */
  bool GetFileAtChangelist(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const FString &RelPath,
    int32 ChangelistNumber,
    FString &OutCachePath,
    bool &bOutIsBinary,
    FString &OutError
  );

  /**
   * Revert files to their head version (restores content + undoes checkout).
   */
  bool RevertFiles(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const TArray<FString> &RelPaths,
    FString &OutError
  );

  /**
   * Mark files for add (persisted in daemon state.json).
   */
  bool MarkForAdd(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const TArray<FString> &RelPaths,
    FString &OutError
  );

  /**
   * Remove files from the marked-for-add list.
   */
  bool UnmarkForAdd(
    const FString &DaemonId,
    const FString &WorkspaceId,
    const TArray<FString> &RelPaths,
    FString &OutError
  );

  // ---- Settings / Workspace-creation API ----

  /**
   * Initiate device-code login flow for a new account.
   * Returns the device code and URL the user must visit.
   * The daemon keeps polling in the background; call GetUser()
   * once the user has completed the browser flow.
   */
  bool Login(
    const FString &Endpoint,
    const FString &DaemonId,
    FString &OutCode,
    FString &OutUrl,
    FString &OutError
  );

  /** List organizations accessible to an account */
  bool ListOrgs(
    const FString &DaemonId,
    TArray<TSharedPtr<FJsonValue>> &OutOrgs,
    FString &OutError
  );

  /** List repositories in an organization */
  bool ListRepos(
    const FString &DaemonId,
    const FString &OrgId,
    TArray<TSharedPtr<FJsonValue>> &OutRepos,
    FString &OutError
  );

  /** Create a new repository in an organization */
  bool CreateRepo(
    const FString &DaemonId,
    const FString &OrgId,
    const FString &RepoName,
    TSharedPtr<FJsonObject> &OutRepo,
    FString &OutError
  );

  /** Create a workspace (registers with daemon + server) */
  bool CreateWorkspace(
    const FString &DaemonId,
    const FString &RepoId,
    const FString &Name,
    const FString &LocalPath,
    const FString &DefaultBranchName,
    TSharedPtr<FJsonObject> &OutWorkspace,
    FString &OutError
  );

private:
  FString DaemonUrl;

  /**
   * Make a synchronous HTTP request and return the response.
   * Blocks until complete or timeout.
   */
  bool DoHttpRequest(
    const FString &Verb,
    const FString &Url,
    const FString &Body,
    FString &OutResponse,
    int32 &OutResponseCode
  );

  /** Build a GET URL with tRPC query parameters */
  FString BuildQueryUrl(
    const FString &ProcedurePath, const TSharedPtr<FJsonObject> &Input
  );

  /** Build the JSON body for a tRPC mutation */
  FString BuildMutationBody(const TSharedPtr<FJsonObject> &Input);

  /** Parse a tRPC response and extract the data */
  bool ParseTrpcResponse(
    const FString &ResponseBody,
    TSharedPtr<FJsonObject> &OutData,
    FString &OutError
  );

  /** Serialize a JSON object to a compact string */
  static FString JsonToString(const TSharedPtr<FJsonObject> &JsonObj);
};
