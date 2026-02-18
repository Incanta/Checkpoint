// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointSourceControlOperations.h"

#include "CheckpointSourceControlCommand.h"
#include "CheckpointSourceControlModule.h"
#include "CheckpointSourceControlProvider.h"
#include "SourceControlOperations.h"

// ---- Connect ----

bool FCheckpointConnectWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();
  bool bSettingsOk = Settings.LoadFromConfigFiles();

  FString Error;
  TSharedPtr<FJsonObject> UserObj;

  if (!bSettingsOk) {
    UE_LOG(
      LogCheckpointSourceControl,
      Warning,
      TEXT("Checkpoint: invalid configuration, cannot connect to daemon")
    );
    InCommand.ResultInfo.ErrorMessages.Add(
      FText::FromString(TEXT("Invalid Checkpoint configuration"))
    );
    return false;
  }

  if (!Client.GetUser(Settings.GetDaemonId(), UserObj, Error)) {
    UE_LOG(
      LogCheckpointSourceControl, Warning, TEXT("Connect failed: %s"), *Error
    );
    InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Error));
    return false;
  }

  SccProvider.Init(true);

  UE_LOG(
    LogCheckpointSourceControl,
    Log,
    TEXT("Connected to Checkpoint daemon successfully")
  );

  return true;
}

bool FCheckpointConnectWorker::UpdateStates() {
  return true;
}

// ---- CheckOut ----

bool FCheckpointCheckOutWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  bool bAllSucceeded = true;

  for (const FString &File : InCommand.Files) {
    FString RelPath = SccProvider.ToRelativePath(File);
    FString Error;

    if (RelPath.IsEmpty() || RelPath.StartsWith(TEXT("../")) ||
        RelPath.StartsWith(TEXT("/"))) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("File '%s' is outside of the workspace root, cannot check out"),
        *File
      );
      InCommand.ResultInfo.ErrorMessages.Add(
        FText::FromString(
          FString::Printf(
            TEXT(
              "File '%s' is outside of the workspace root, cannot check out"
            ),
            *File
          )
        )
      );
      bAllSucceeded = false;
      continue;
    }

    if (!Client.Checkout(
          Settings.GetDaemonId(),
          Settings.GetWorkspaceId(),
          RelPath,
          false, // not locked
          Error
        )) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("Checkout failed for %s: %s"),
        *File,
        *Error
      );
      InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Error));
      bAllSucceeded = false;
    } else {
      UpdatedFiles.Add(File);
    }
  }

  return bAllSucceeded;
}

bool FCheckpointCheckOutWorker::UpdateStates() {
  auto &SccProvider = GetProvider();
  for (const FString &File : UpdatedFiles) {
    auto State = SccProvider.GetStateInternal(File);
    if (State->GetFileStatus() == ECheckpointFileStatus::ChangedNotCheckedOut) {
      State->SetFileStatus(ECheckpointFileStatus::ChangedCheckedOut);
    } else {
      State->SetFileStatus(ECheckpointFileStatus::NotChangedCheckedOut);
    }
  }
  if (UpdatedFiles.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }
  return UpdatedFiles.Num() > 0;
}

// ---- CheckIn ----

bool FCheckpointCheckInWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  // Build the modifications array from the files
  TArray<TSharedPtr<FJsonValue>> Modifications;

  for (const FString &File : InCommand.Files) {
    FString RelPath = SccProvider.ToRelativePath(File);

    if (RelPath.IsEmpty() || RelPath.StartsWith(TEXT("../")) ||
        RelPath.StartsWith(TEXT("/"))) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("File '%s' is outside of the workspace root, cannot check in"),
        *File
      );
      InCommand.ResultInfo.ErrorMessages.Add(
        FText::FromString(
          FString::Printf(
            TEXT("File '%s' is outside of the workspace root, cannot check in"),
            *File
          )
        )
      );
      return false;
    }

    auto State = SccProvider.GetStateInternal(File);

    TSharedPtr<FJsonObject> ModObj = MakeShareable(new FJsonObject());
    ModObj->SetStringField(TEXT("path"), RelPath);

    if (State->GetFileStatus() == ECheckpointFileStatus::Deleted) {
      ModObj->SetBoolField(TEXT("delete"), true);
    } else {
      ModObj->SetBoolField(TEXT("delete"), false);
    }

    if (State->GetFileStatus() == ECheckpointFileStatus::Renamed) {
      // For renamed files, we'd need the old path
      // For now, treat as modify
      ModObj->SetBoolField(TEXT("delete"), false);
    }

    Modifications.Add(MakeShareable(new FJsonValueObject(ModObj)));
    SubmittedFiles.Add(File);
  }

  // Get the description from the CheckIn operation
  FString Description = TEXT("Submitted from Unreal Engine");
  TSharedRef<FCheckIn> CheckInOp =
    StaticCastSharedRef<FCheckIn>(InCommand.Operation);
  Description = CheckInOp->GetDescription().ToString();

  bool bKeepCheckedOut = CheckInOp->GetKeepCheckedOut();

  FString Error;
  if (!Client.Submit(
        Settings.GetDaemonId(),
        Settings.GetWorkspaceId(),
        Description,
        Modifications,
        false, // not shelved
        bKeepCheckedOut,
        Error
      )) {
    UE_LOG(
      LogCheckpointSourceControl, Error, TEXT("Submit failed: %s"), *Error
    );
    InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Error));
    return false;
  }

  UE_LOG(
    LogCheckpointSourceControl,
    Log,
    TEXT("Successfully submitted %d files"),
    SubmittedFiles.Num()
  );

  return true;
}

bool FCheckpointCheckInWorker::UpdateStates() {
  auto &SccProvider = GetProvider();
  for (const FString &File : SubmittedFiles) {
    auto State = SccProvider.GetStateInternal(File);
    State->SetFileStatus(ECheckpointFileStatus::ReadOnlyControlled);
  }
  if (SubmittedFiles.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }
  return SubmittedFiles.Num() > 0;
}

// ---- MarkForAdd ----

bool FCheckpointMarkForAddWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  TArray<FString> RelPaths;
  for (const FString &File : InCommand.Files) {
    FString RelPath = SccProvider.ToRelativePath(File);

    if (RelPath.IsEmpty() || RelPath.StartsWith(TEXT("../")) ||
        RelPath.StartsWith(TEXT("/"))) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("File '%s' is outside of the workspace root, cannot mark for add"),
        *File
      );
      InCommand.ResultInfo.ErrorMessages.Add(
        FText::FromString(
          FString::Printf(
            TEXT(
              "File '%s' is outside of the workspace root, cannot mark for add"
            ),
            *File
          )
        )
      );
      continue;
    }

    RelPaths.Add(RelPath);
    AddedFiles.Add(File);
  }

  FString Error;
  if (!Client.MarkForAdd(
        Settings.GetDaemonId(), Settings.GetWorkspaceId(), RelPaths, Error
      )) {
    UE_LOG(
      LogCheckpointSourceControl, Warning, TEXT("MarkForAdd failed: %s"), *Error
    );
    // Still mark locally even if daemon call fails, so UE
    // state stays consistent for the session.
  }

  return true;
}

bool FCheckpointMarkForAddWorker::UpdateStates() {
  auto &SccProvider = GetProvider();
  for (const FString &File : AddedFiles) {
    auto State = SccProvider.GetStateInternal(File);
    State->SetFileStatus(ECheckpointFileStatus::Added);
  }
  if (AddedFiles.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }
  return AddedFiles.Num() > 0;
}

// ---- Delete ----

bool FCheckpointDeleteWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  // Mark files as deleted locally. The actual deletion
  // happens when submitting.
  for (const FString &File : InCommand.Files) {
    DeletedFiles.Add(File);
  }
  return true;
}

bool FCheckpointDeleteWorker::UpdateStates() {
  auto &SccProvider = GetProvider();
  for (const FString &File : DeletedFiles) {
    auto State = SccProvider.GetStateInternal(File);
    State->SetFileStatus(ECheckpointFileStatus::Deleted);
  }
  if (DeletedFiles.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }
  return DeletedFiles.Num() > 0;
}

// ---- Revert ----

bool FCheckpointRevertWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  // Collect relative paths for batch revert
  TArray<FString> RelPaths;
  for (const FString &File : InCommand.Files) {
    FString RelPath = SccProvider.ToRelativePath(File);

    if (RelPath.IsEmpty() || RelPath.StartsWith(TEXT("../")) ||
        RelPath.StartsWith(TEXT("/"))) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("File '%s' is outside of the workspace root, cannot revert"),
        *File
      );
      InCommand.ResultInfo.ErrorMessages.Add(
        FText::FromString(
          FString::Printf(
            TEXT("File '%s' is outside of the workspace root, cannot revert"),
            *File
          )
        )
      );
      continue;
    }

    RelPaths.Add(RelPath);
  }

  FString Error;
  if (!Client.RevertFiles(
        Settings.GetDaemonId(), Settings.GetWorkspaceId(), RelPaths, Error
      )) {
    UE_LOG(
      LogCheckpointSourceControl,
      Warning,
      TEXT("RevertFiles failed: %s"),
      *Error
    );
    InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Error));
    return false;
  }

  // All files successfully reverted
  for (const FString &File : InCommand.Files) {
    RevertedFiles.Add(File);
  }

  return true;
}

bool FCheckpointRevertWorker::UpdateStates() {
  auto &SccProvider = GetProvider();
  for (const FString &File : RevertedFiles) {
    auto State = SccProvider.GetStateInternal(File);

    // Reset to appropriate state
    if (State->GetFileStatus() == ECheckpointFileStatus::Added) {
      State->SetFileStatus(ECheckpointFileStatus::Local);
    } else if (State->GetFileStatus() == ECheckpointFileStatus::Deleted) {
      State->SetFileStatus(ECheckpointFileStatus::WritableControlled);
    } else {
      State->SetFileStatus(ECheckpointFileStatus::WritableControlled);
    }
  }
  if (RevertedFiles.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }
  return RevertedFiles.Num() > 0;
}

// ---- Sync ----

bool FCheckpointSyncWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  FString Error;

  // Convert file paths if specific files requested
  TArray<FString> RelPaths;
  for (const FString &File : InCommand.Files) {
    FString RelPath = SccProvider.ToRelativePath(File);

    if (RelPath.IsEmpty() || RelPath.StartsWith(TEXT("../")) ||
        RelPath.StartsWith(TEXT("/"))) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("File '%s' is outside of the workspace root, cannot sync"),
        *File
      );
      InCommand.ResultInfo.ErrorMessages.Add(
        FText::FromString(
          FString::Printf(
            TEXT("File '%s' is outside of the workspace root, cannot sync"),
            *File
          )
        )
      );
      continue;
    }

    RelPaths.Add(RelPath);
  }

  const TArray<FString> *PathsPtr = RelPaths.Num() > 0 ? &RelPaths : nullptr;

  if (!Client.Pull(
        Settings.GetDaemonId(), Settings.GetWorkspaceId(), PathsPtr, Error
      )) {
    UE_LOG(
      LogCheckpointSourceControl, Error, TEXT("Pull/Sync failed: %s"), *Error
    );
    InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Error));
    return false;
  }

  UE_LOG(
    LogCheckpointSourceControl, Log, TEXT("Successfully synced workspace")
  );

  // Tell the daemon to refresh its workspace state cache
  FString RefreshError;
  if (!Client.RefreshWorkspace(
        Settings.GetDaemonId(), Settings.GetWorkspaceId(), RefreshError
      )) {
    UE_LOG(
      LogCheckpointSourceControl,
      Warning,
      TEXT("RefreshWorkspace after sync failed: %s"),
      *RefreshError
    );
  }

  // Re-query file states for synced files so the editor updates immediately
  if (InCommand.Files.Num() > 0) {
    TMap<FString, TArray<FString>> FilesByDir;
    for (const FString &File : InCommand.Files) {
      FString Dir = FPaths::GetPath(File);
      FilesByDir.FindOrAdd(Dir).Add(File);
    }

    for (auto &DirPair : FilesByDir) {
      FString RelDir = SccProvider.ToRelativePath(DirPair.Key);
      FString DirError;
      TSharedPtr<FJsonObject> DirResult;

      if (RelDir.IsEmpty() || RelDir.StartsWith(TEXT("../")) ||
          RelDir.StartsWith(TEXT("/"))) {
        UE_LOG(
          LogCheckpointSourceControl,
          Warning,
          TEXT("Directory '%s' is outside of the workspace root, cannot sync"),
          *DirPair.Key
        );
        InCommand.ResultInfo.ErrorMessages.Add(
          FText::FromString(
            FString::Printf(
              TEXT(
                "Directory '%s' is outside of the workspace root, cannot sync"
              ),
              *DirPair.Key
            )
          )
        );
        continue;
      }

      if (!Client.GetDirectory(
            Settings.GetDaemonId(),
            Settings.GetWorkspaceId(),
            RelDir,
            DirResult,
            DirError
          )) {
        continue;
      }

      if (!DirResult.IsValid()) continue;

      const TArray<TSharedPtr<FJsonValue>> *Children;
      if (!DirResult->TryGetArrayField(TEXT("children"), Children)) {
        continue;
      }

      TMap<FString, TSharedPtr<FJsonObject>> ChildMap;
      for (const auto &Child : *Children) {
        auto ChildObj = Child->AsObject();
        if (!ChildObj.IsValid()) continue;
        FString ChildPath;
        ChildObj->TryGetStringField(TEXT("path"), ChildPath);
        if (!ChildPath.IsEmpty()) {
          ChildMap.Add(ChildPath, ChildObj);
        }
      }

      for (const FString &AbsFile : DirPair.Value) {
        FString RelFile = SccProvider.ToRelativePath(AbsFile);
        FString Filename = FPaths::GetCleanFilename(RelFile);

        TSharedPtr<FJsonObject> *Found = ChildMap.Find(Filename);
        if (Found && Found->IsValid()) {
          int32 Status = 0;
          (*Found)->TryGetNumberField(TEXT("status"), Status);
          FileStates.Add(
            AbsFile, static_cast<ECheckpointFileStatus::Type>(Status)
          );
        } else if (FPaths::FileExists(AbsFile)) {
          FileStates.Add(AbsFile, ECheckpointFileStatus::Local);
        }
      }
    }
  }

  return true;
}

bool FCheckpointSyncWorker::UpdateStates() {
  auto &SccProvider = GetProvider();

  for (auto &Pair : FileStates) {
    auto State = SccProvider.GetStateInternal(Pair.Key);
    State->SetFileStatus(Pair.Value);
    State->TimeStamp = FDateTime::Now();
  }

  if (FileStates.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }

  return FileStates.Num() > 0;
}

// ---- UpdateStatus ----

bool FCheckpointUpdateStatusWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  if (Settings.GetWorkspaceId().IsEmpty() || Settings.GetDaemonId().IsEmpty()) {
    return false;
  }

  // Group files by directory to minimize API calls
  TMap<FString, TArray<FString>> FilesByDir;
  for (const FString &File : InCommand.Files) {
    FString Dir = FPaths::GetPath(File);
    FilesByDir.FindOrAdd(Dir).Add(File);
  }

  // Query each directory
  for (auto &Pair : FilesByDir) {
    FString RelDir = SccProvider.ToRelativePath(Pair.Key);
    FString Error;
    TSharedPtr<FJsonObject> DirResult;

    if (RelDir.IsEmpty() || RelDir.StartsWith(TEXT("../")) ||
        RelDir.StartsWith(TEXT("/"))) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT(
          "Directory '%s' is outside of the workspace root, cannot update status"
        ),
        *Pair.Key
      );
      InCommand.ResultInfo.ErrorMessages.Add(
        FText::FromString(
          FString::Printf(
            TEXT(
              "Directory '%s' is outside of the workspace root, cannot update status"
            ),
            *Pair.Key
          )
        )
      );
      continue;
    }

    if (!Client.GetDirectory(
          Settings.GetDaemonId(),
          Settings.GetWorkspaceId(),
          RelDir,
          DirResult,
          Error
        )) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("GetDirectory failed for %s: %s"),
        *RelDir,
        *Error
      );
      continue;
    }

    if (!DirResult.IsValid()) {
      continue;
    }

    // Parse children
    const TArray<TSharedPtr<FJsonValue>> *Children;
    if (!DirResult->TryGetArrayField(TEXT("children"), Children)) {
      continue;
    }

    // Build a map of relative path -> file info
    TMap<FString, TSharedPtr<FJsonObject>> ChildMap;
    for (const auto &Child : *Children) {
      auto ChildObj = Child->AsObject();
      if (!ChildObj.IsValid()) continue;

      FString ChildPath;
      ChildObj->TryGetStringField(TEXT("path"), ChildPath);
      if (!ChildPath.IsEmpty()) {
        ChildMap.Add(ChildPath, ChildObj);
      }
    }

    // Map requested files to their statuses
    for (const FString &AbsFile : Pair.Value) {
      FString RelFile = SccProvider.ToRelativePath(AbsFile);

      // Get just the filename for matching
      FString Filename = FPaths::GetCleanFilename(RelFile);

      TSharedPtr<FJsonObject> *Found = ChildMap.Find(Filename);

      if (Found && Found->IsValid()) {
        int32 Status = 0;
        (*Found)->TryGetNumberField(TEXT("status"), Status);
        FileStates.Add(
          AbsFile, static_cast<ECheckpointFileStatus::Type>(Status)
        );

        // Check for other user checkouts
        const TArray<TSharedPtr<FJsonValue>> *Checkouts;
        if ((*Found)->TryGetArrayField(TEXT("checkouts"), Checkouts)) {
          for (const auto &CheckoutVal : *Checkouts) {
            auto CheckoutObj = CheckoutVal->AsObject();
            if (!CheckoutObj.IsValid()) continue;

            // Check if this is another user's checkout
            const TSharedPtr<FJsonObject> *UserObj;
            if (CheckoutObj->TryGetObjectField(TEXT("user"), UserObj)) {
              FString Email;
              (*UserObj)->TryGetStringField(TEXT("email"), Email);
              if (!Email.IsEmpty() && Email != SccProvider.GetUserEmail()) {
                FString UserName;
                (*UserObj)->TryGetStringField(TEXT("username"), UserName);
                OtherCheckouts.Add(
                  AbsFile, UserName.IsEmpty() ? Email : UserName
                );
              }
            }

            bool bLocked = false;
            CheckoutObj->TryGetBoolField(TEXT("locked"), bLocked);
            if (bLocked) {
              LockedFiles.Add(AbsFile);
            }
          }
        }
      } else {
        // File not found in directory listing
        // Could be Local or Unknown
        if (FPaths::FileExists(AbsFile)) {
          FileStates.Add(AbsFile, ECheckpointFileStatus::Local);
        } else {
          FileStates.Add(AbsFile, ECheckpointFileStatus::Unknown);
        }
      }
    }
  }

  // If UpdateStatus requests history, fetch it
  auto UpdateStatusOp = StaticCastSharedRef<FUpdateStatus>(InCommand.Operation);
  if (UpdateStatusOp->ShouldUpdateHistory()) {
    for (const FString &File : InCommand.Files) {
      FString RelPath = SccProvider.ToRelativePath(File);
      FString Error;
      TArray<TSharedPtr<FJsonValue>> HistoryEntries;

      if (RelPath.IsEmpty() || RelPath.StartsWith(TEXT("../")) ||
          RelPath.StartsWith(TEXT("/"))) {
        UE_LOG(
          LogCheckpointSourceControl,
          Warning,
          TEXT(
            "File '%s' is outside of the workspace root, cannot fetch history"
          ),
          *File
        );
        InCommand.ResultInfo.ErrorMessages.Add(
          FText::FromString(
            FString::Printf(
              TEXT(
                "File '%s' is outside of the workspace root, cannot fetch history"
              ),
              *File
            )
          )
        );
        continue;
      }

      if (Client.GetFileHistory(
            Settings.GetDaemonId(),
            Settings.GetWorkspaceId(),
            RelPath,
            HistoryEntries,
            Error
          )) {
        TArray<
          TSharedRef<FCheckpointSourceControlRevision, ESPMode::ThreadSafe>>
          Revisions;

        for (const auto &Entry : HistoryEntries) {
          auto EntryObj = Entry->AsObject();
          if (!EntryObj.IsValid()) continue;

          FCheckpointSourceControlRevision *RevPtr =
            new FCheckpointSourceControlRevision();
          RevPtr->Filename = File;
          RevPtr->SetProvider(&SccProvider);

          int32 CLNum = 0;
          EntryObj->TryGetNumberField(TEXT("changelistNumber"), CLNum);
          RevPtr->RevisionNumber = CLNum;
          RevPtr->Revision = FString::FromInt(CLNum);

          FString ChangeType;
          EntryObj->TryGetStringField(TEXT("changeType"), ChangeType);
          RevPtr->Action = ChangeType;

          // Get changelist info
          const TSharedPtr<FJsonObject> *CLObj;
          if (EntryObj->TryGetObjectField(TEXT("changelist"), CLObj)) {
            FString Message;
            (*CLObj)->TryGetStringField(TEXT("message"), Message);
            RevPtr->Description = Message;

            FString CreatedAt;
            (*CLObj)->TryGetStringField(TEXT("createdAt"), CreatedAt);
            FDateTime::ParseIso8601(*CreatedAt, RevPtr->Date);

            const TSharedPtr<FJsonObject> *UserObj;
            if ((*CLObj)->TryGetObjectField(TEXT("user"), UserObj)) {
              FString Email;
              (*UserObj)->TryGetStringField(TEXT("email"), Email);
              RevPtr->UserName = Email;
            }
          }

          Revisions.Add(MakeShareable(RevPtr));
        }

        FileHistories.Add(File, Revisions);
      }
    }
  }

  return true;
}

bool FCheckpointUpdateStatusWorker::UpdateStates() {
  auto &SccProvider = GetProvider();

  for (auto &Pair : FileStates) {
    auto State = SccProvider.GetStateInternal(Pair.Key);
    State->SetFileStatus(Pair.Value);
    State->TimeStamp = FDateTime::Now();

    // Set other checkout info
    if (FString *Other = OtherCheckouts.Find(Pair.Key)) {
      State->OtherUserCheckedOut = *Other;
    } else {
      State->OtherUserCheckedOut.Empty();
    }

    State->bIsLocked = LockedFiles.Contains(Pair.Key);
  }

  // Update histories
  for (auto &Pair : FileHistories) {
    auto State = SccProvider.GetStateInternal(Pair.Key);
    State->History = Pair.Value;
  }

  if (FileStates.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }

  return FileStates.Num() > 0;
}

// ---- Copy ----

bool FCheckpointCopyWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  UE_LOG(
    LogCheckpointSourceControl,
    Warning,
    TEXT("Copy/Branch operation not supported by Checkpoint")
  );
  return false;
}

// ---- GetFileList ----

bool FCheckpointGetFileListWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  // GetFileList can be implemented via getDirectory
  // but is not commonly used. Stub for now.
  UE_LOG(
    LogCheckpointSourceControl,
    Log,
    TEXT("GetFileList called with %d files"),
    InCommand.Files.Num()
  );
  return true;
}

// ---- UpdateChangelistsStatus ----

bool FCheckpointUpdateChangelistsStatusWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  if (Settings.GetWorkspaceId().IsEmpty() || Settings.GetDaemonId().IsEmpty()) {
    return false;
  }

  auto Op =
    StaticCastSharedRef<FUpdatePendingChangelistsStatus>(InCommand.Operation);

  // Determine if we need to update the default changelist
  bool bUpdateDefault = Op->ShouldUpdateAllChangelists();

  if (!bUpdateDefault) {
    // Check if the default changelist is in the list
    for (const FSourceControlChangelistRef &CL : Op->GetChangelistsToUpdate()) {
      if (CL->IsDefault()) {
        bUpdateDefault = true;
        break;
      }
    }
  }

  if (!bUpdateDefault) {
    // Nothing to do — Checkpoint only has a default changelist for now
    return true;
  }

  // Get pending changes from the daemon via refresh
  if (Op->ShouldUpdateFilesStates()) {
    FString Error;
    TMap<FString, int32> PendingFiles;

    if (!Client.GetPendingChanges(
          Settings.GetDaemonId(), Settings.GetWorkspaceId(), PendingFiles, Error
        )) {
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("GetPendingChanges failed: %s"),
        *Error
      );
      // Still succeed — we just won't have file states
      return true;
    }

    for (const auto &Pair : PendingFiles) {
      FString AbsPath = SccProvider.ToAbsolutePath(Pair.Key);

      ECheckpointFileStatus::Type Status =
        static_cast<ECheckpointFileStatus::Type>(Pair.Value);

      FCheckpointSourceControlState FileState(AbsPath, Status);
      if (FileState.CanCheckIn()) {
        DefaultChangelistFiles.Add(
          AbsPath, static_cast<ECheckpointFileStatus::Type>(Pair.Value)
        );
      }
    }
  }

  // Shelved files: not supported yet
  // When shelving support is added, ShouldUpdateShelvedFilesStates() will
  // be handled here.

  return true;
}

bool FCheckpointUpdateChangelistsStatusWorker::UpdateStates() {
  auto &SccProvider = GetProvider();

  // Ensure the default changelist exists in the cache
  FCheckpointSourceControlChangelist DefaultCL;
  auto DefaultCLState = SccProvider.GetChangelistStateInternal(DefaultCL);

  // Update description
  DefaultCLState->Description = TEXT("");
  DefaultCLState->TimeStamp = FDateTime::Now();

  // Clear and rebuild file list
  DefaultCLState->Files.Empty();

  for (auto &Pair : DefaultChangelistFiles) {
    auto FileState = SccProvider.GetStateInternal(Pair.Key);
    FileState->SetFileStatus(Pair.Value);
    FileState->TimeStamp = FDateTime::Now();

    // Set other checkout info
    if (FString *Other = OtherCheckouts.Find(Pair.Key)) {
      FileState->OtherUserCheckedOut = *Other;
    }

    FileState->bIsLocked = LockedFiles.Contains(Pair.Key);

    DefaultCLState->Files.Add(FileState);
  }

  // Shelved files: empty for now
  DefaultCLState->ShelvedFiles.Empty();

  if (DefaultChangelistFiles.Num() > 0) {
    SccProvider.BroadcastStateChanged();
  }

  return true;
}

// ---- Worker Registration ----

namespace {
  TMap<
    FName,
    TFunction<FCheckpointWorkerRef(FCheckpointSourceControlProvider &)>>
    WorkerCreators;
}

template <typename WorkerType> void RegisterWorkerType() {
  WorkerType TempWorker(*(FCheckpointSourceControlProvider *)nullptr);
  FName OpName = TempWorker.GetName();
  WorkerCreators.Add(
    OpName,
    [](FCheckpointSourceControlProvider &Provider) -> FCheckpointWorkerRef {
      return MakeShareable(new WorkerType(Provider));
    }
  );
}

void CheckpointSourceControlWorkers::RegisterWorkers() {
  WorkerCreators.Empty();

  // Use a lambda-based approach to register without
  // instantiating
  auto Register =
    [](
      const FName &Name,
      TFunction<FCheckpointWorkerRef(FCheckpointSourceControlProvider &)>
        Creator
    ) { WorkerCreators.Add(Name, Creator); };

  Register(
    TEXT("Connect"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointConnectWorker(P));
    }
  );

  Register(
    TEXT("CheckOut"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointCheckOutWorker(P));
    }
  );

  Register(
    TEXT("CheckIn"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointCheckInWorker(P));
    }
  );

  Register(
    TEXT("MarkForAdd"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointMarkForAddWorker(P));
    }
  );

  Register(
    TEXT("Delete"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointDeleteWorker(P));
    }
  );

  Register(
    TEXT("Revert"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointRevertWorker(P));
    }
  );

  Register(
    TEXT("Sync"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointSyncWorker(P));
    }
  );

  Register(
    TEXT("UpdateStatus"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointUpdateStatusWorker(P));
    }
  );

  Register(
    TEXT("Copy"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointCopyWorker(P));
    }
  );

  Register(
    TEXT("GetFileList"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointGetFileListWorker(P));
    }
  );

  Register(
    TEXT("UpdateChangelistsStatus"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointUpdateChangelistsStatusWorker(P));
    }
  );
}

// Expose the creation function for the provider
TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
CreateCheckpointWorker(
  const FName &InOperationName, FCheckpointSourceControlProvider &Provider
) {
  auto *Creator = WorkerCreators.Find(InOperationName);
  if (Creator) {
    return (*Creator)(Provider);
  }
  return nullptr;
}
