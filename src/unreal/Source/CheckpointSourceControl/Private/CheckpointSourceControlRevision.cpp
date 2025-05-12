// Copyright (c) 2014-2023 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#include "CheckpointSourceControlRevision.h"

#include "CheckpointSourceControlModule.h"
#include "HAL/FileManager.h"
#include "ISourceControlModule.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"

#define LOCTEXT_NAMESPACE "CheckpointSourceControl"

bool FCheckpointSourceControlRevision::Get(
  FString &InOutFilename, EConcurrency::Type InConcurrency
) const {
  return false;
}

bool FCheckpointSourceControlRevision::GetAnnotated(
  TArray<FAnnotationLine> &OutLines
) const {
  return false;
}

bool FCheckpointSourceControlRevision::GetAnnotated(
  FString &InOutFilename
) const {
  return false;
}

const FString &FCheckpointSourceControlRevision::GetFilename() const {
  static FString EmptyString(TEXT(""));
  return EmptyString;
}

int32 FCheckpointSourceControlRevision::GetRevisionNumber() const {
  return 0;
}

const FString &FCheckpointSourceControlRevision::GetRevision() const {
  static FString EmptyString(TEXT(""));
  return EmptyString;
}

const FString &FCheckpointSourceControlRevision::GetDescription() const {
  static FString EmptyString(TEXT(""));
  return EmptyString;
}

const FString &FCheckpointSourceControlRevision::GetUserName() const {
  static FString EmptyString(TEXT(""));
  return EmptyString;
}

const FString &FCheckpointSourceControlRevision::GetClientSpec() const {
  static FString EmptyString(TEXT(""));
  return EmptyString;
}

const FString &FCheckpointSourceControlRevision::GetAction() const {
  static FString EmptyString(TEXT(""));
  return EmptyString;
}

TSharedPtr<class ISourceControlRevision, ESPMode::ThreadSafe>
FCheckpointSourceControlRevision::GetBranchSource() const {
  // if this revision was copied/moved from some other revision
  return TSharedPtr<
    class ISourceControlRevision,
    ESPMode::ThreadSafe>(); // TODO MIKE HERE
}

// const FDateTime &FCheckpointSourceControlRevision::GetDate() const {
//   FDateTime d;
//   return d;
// }

int32 FCheckpointSourceControlRevision::GetCheckInIdentifier() const {
  return 0;
}

int32 FCheckpointSourceControlRevision::GetFileSize() const {
  return 0;
}

#undef LOCTEXT_NAMESPACE
