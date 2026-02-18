// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointSourceControlRevision.h"

#include "CheckpointSourceControlModule.h"
#include "CheckpointSourceControlProvider.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"

bool FCheckpointSourceControlRevision::Get(
  FString& InOutFilename,
  EConcurrency::Type InConcurrency
) const {
  if (!Provider) {
    UE_LOG(
      LogCheckpointSourceControl,
      Error,
      TEXT("Revision has no provider reference")
    );
    return false;
  }

  auto& Client = Provider->GetDaemonClient();
  auto& Settings = Provider->AccessSettings();

  FString RelPath = Provider->ToRelativePath(Filename);

  if (RelPath.IsEmpty() || RelPath.StartsWith(TEXT("../")) || RelPath.StartsWith(TEXT("/"))) {
    UE_LOG(
      LogCheckpointSourceControl,
      Warning,
      TEXT("File '%s' is outside of the workspace root, cannot get revision"),
      *Filename
    );
    return false;
  }

  FString CachePath;
  bool bIsBinary = false;
  FString Error;

  if (!Client.GetFileAtChangelist(
    Settings.GetDaemonId(),
    Settings.GetWorkspaceId(),
    RelPath,
    RevisionNumber,
    CachePath,
    bIsBinary,
    Error
  )) {
    UE_LOG(
      LogCheckpointSourceControl,
      Error,
      TEXT("Failed to get file at changelist %d: %s"),
      RevisionNumber,
      *Error
    );
    return false;
  }

  // If caller provided a filename, copy the cached file there.
  // Otherwise, set InOutFilename to the cache path.
  if (InOutFilename.IsEmpty()) {
    // Generate a temp filename
    FString TempDir = FPaths::CreateTempFilename(
      *FPaths::ProjectSavedDir(),
      TEXT("Checkpoint-")
    );
    InOutFilename = TempDir;
  }

  // Copy cached file to the requested output path
  if (IFileManager::Get().Copy(
    *InOutFilename,
    *CachePath
  ) != COPY_OK) {
    UE_LOG(
      LogCheckpointSourceControl,
      Error,
      TEXT("Failed to copy cached file '%s' to '%s'"),
      *CachePath,
      *InOutFilename
    );
    return false;
  }

  return true;
}

bool FCheckpointSourceControlRevision::GetAnnotated(
  TArray<FAnnotationLine>& OutLines
) const {
  // Annotation (blame) not supported
  return false;
}

bool FCheckpointSourceControlRevision::GetAnnotated(
  FString& InOutFilename
) const {
  // Annotation (blame) not supported
  return false;
}
