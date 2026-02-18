// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointSourceControlSettings.h"

#include "HAL/PlatformProcess.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FCheckpointSourceControlSettings::FCheckpointSourceControlSettings() :
  DaemonPort(3010), bConfigured(false) {}

FString FCheckpointSourceControlSettings::FindWorkspaceJson(
  const FString &StartDir
) {
  FString Dir = StartDir;
  while (!Dir.IsEmpty()) {
    FString Candidate =
      FPaths::Combine(Dir, TEXT(".checkpoint"), TEXT("workspace.json"));
    if (FPaths::FileExists(Candidate)) {
      return Candidate;
    }

    // Move to parent
    FString Parent = FPaths::GetPath(Dir);
    if (Parent == Dir || Parent.IsEmpty()) {
      break;
    }
    Dir = Parent;
  }
  return FString();
}

TSharedPtr<FJsonObject> FCheckpointSourceControlSettings::ReadJsonFile(
  const FString &FilePath
) {
  FString Content;
  if (!FFileHelper::LoadFileToString(Content, *FilePath)) {
    return nullptr;
  }

  TSharedPtr<FJsonObject> JsonObj;
  TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Content);
  if (!FJsonSerializer::Deserialize(Reader, JsonObj) || !JsonObj.IsValid()) {
    return nullptr;
  }
  return JsonObj;
}

bool FCheckpointSourceControlSettings::LoadFromConfigFiles() {
  bConfigured = false;

  // 1. Find .checkpoint/workspace.json by walking up from project dir
  FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
  FPaths::NormalizeDirectoryName(ProjectDir);

  FString WorkspaceJsonPath = FindWorkspaceJson(ProjectDir);
  if (WorkspaceJsonPath.IsEmpty()) {
    UE_LOG(
      LogTemp,
      Log,
      TEXT(
        "Checkpoint: No .checkpoint/workspace.json found "
        "above %s"
      ),
      *ProjectDir
    );
    return false;
  }

  TSharedPtr<FJsonObject> WsJson = ReadJsonFile(WorkspaceJsonPath);
  if (!WsJson.IsValid()) {
    UE_LOG(
      LogTemp,
      Warning,
      TEXT("Checkpoint: Failed to parse %s"),
      *WorkspaceJsonPath
    );
    return false;
  }

  // Extract workspace fields
  WsJson->TryGetStringField(TEXT("id"), WorkspaceId);
  WsJson->TryGetStringField(TEXT("daemonId"), DaemonId);
  WsJson->TryGetStringField(TEXT("localPath"), WorkspacePath);
  WsJson->TryGetStringField(TEXT("name"), WorkspaceName);
  WsJson->TryGetStringField(TEXT("repoId"), RepoId);
  WsJson->TryGetStringField(TEXT("orgId"), OrgId);
  WsJson->TryGetStringField(TEXT("branchName"), BranchName);

  if (WorkspaceId.IsEmpty() || DaemonId.IsEmpty()) {
    UE_LOG(
      LogTemp,
      Warning,
      TEXT("Checkpoint: workspace.json missing id or daemonId")
    );
    return false;
  }

  // Normalize workspace path separators
  WorkspacePath.ReplaceInline(TEXT("/"), TEXT("\\"));
  FPaths::NormalizeDirectoryName(WorkspacePath);

  // 2. Read daemon.json from $HOME/.checkpoint/daemon.json
  FString HomeDir = FPlatformProcess::UserHomeDir();
  FString DaemonJsonPath =
    FPaths::Combine(HomeDir, TEXT(".checkpoint"), TEXT("daemon.json"));

  TSharedPtr<FJsonObject> DaemonJson = ReadJsonFile(DaemonJsonPath);
  if (DaemonJson.IsValid()) {
    int32 Port = 0;
    if (DaemonJson->TryGetNumberField(TEXT("daemonPort"), Port) && Port > 0 &&
        Port < 65536) {
      DaemonPort = Port;
    }
  } else {
    UE_LOG(
      LogTemp,
      Warning,
      TEXT("Checkpoint: Could not read %s, using default port %d"),
      *DaemonJsonPath,
      DaemonPort
    );
  }

  bConfigured = true;

  UE_LOG(
    LogTemp,
    Log,
    TEXT(
      "Checkpoint: Auto-detected workspace '%s' (%s) "
      "daemonId=%s port=%d"
    ),
    *WorkspaceName,
    *WorkspaceId,
    *DaemonId,
    DaemonPort
  );

  return true;
}

FString FCheckpointSourceControlSettings::GetDaemonUrl() const {
  return FString::Printf(TEXT("http://127.0.0.1:%d"), DaemonPort);
}
