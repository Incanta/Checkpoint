// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointSourceControlOperations.h"

#include "CheckpointSourceControlCommand.h"
#include "CheckpointSourceControlModule.h"
#include "CheckpointSourceControlProvider.h"
#include "Misc/Paths.h"
#include "SourceControlOperations.h"

// ---- Pending changelist helpers ----

namespace {
  /**
   * A branch as a changelist stores it: empty for the domain root, so the
   * domain root's default changelist is Unreal's default changelist.
   */
  FString ToChangelistBranch(
    const FString &BranchName, const FString &DomainBranchName
  ) {
    return BranchName == DomainBranchName ? FString() : BranchName;
  }

  /** The inverse: the branch name the daemon keys things by. */
  FString ToDaemonBranch(
    const FString &ChangelistBranch, const FString &DomainBranchName
  ) {
    return ChangelistBranch.IsEmpty() ? DomainBranchName : ChangelistBranch;
  }

  /**
   * The branch a pending file is going to, as the daemon's destinedBranch():
   * its open claim's, else its first claim's, else the domain root. Returned
   * in changelist form (empty for the domain root).
   */
  FString DestinedBranch(
    const TSharedPtr<FJsonObject> &File, const FString &DomainBranchName
  ) {
    const TArray<TSharedPtr<FJsonValue>> *Claims;
    if (!File->TryGetArrayField(TEXT("claims"), Claims)) {
      return FString();
    }

    TSharedPtr<FJsonObject> Chosen;
    for (const auto &ClaimVal : *Claims) {
      auto ClaimObj = ClaimVal->AsObject();
      if (!ClaimObj.IsValid()) continue;
      if (!Chosen.IsValid()) {
        Chosen = ClaimObj;
      }
      FString State;
      ClaimObj->TryGetStringField(TEXT("state"), State);
      if (State == TEXT("OPEN")) {
        Chosen = ClaimObj;
        break;
      }
    }

    FString BranchName;
    if (Chosen.IsValid()) {
      Chosen->TryGetStringField(TEXT("branchName"), BranchName);
    }
    return ToChangelistBranch(BranchName, DomainBranchName);
  }

  /**
   * Which changelist a pending file is in, as the daemon's changelistOf():
   * the numbered one it was staged into while that one targets the file's
   * branch, else its branch's default.
   *
   * Unstaged changes are in no daemon changelist. They are listed in their
   * branch's default one anyway, so they can still be submitted from the
   * editor as they could before changelists existed.
   */
  FCheckpointSourceControlChangelist ChangelistOf(
    const FString &RelPath,
    const TSharedPtr<FJsonObject> &File,
    const FCheckpointPendingChangelists &Changelists,
    const FString &DomainBranchName
  ) {
    const FString BranchName = DestinedBranch(File, DomainBranchName);

    bool bStaged = false;
    File->TryGetBoolField(TEXT("staged"), bStaged);
    if (bStaged) {
      if (const int32 *Id = Changelists.Assignments.Find(RelPath)) {
        const FCheckpointPendingChangelist *Changelist =
          Changelists.Find(*Id);
        if (Changelist &&
            ToChangelistBranch(Changelist->BranchName, DomainBranchName) ==
              BranchName) {
          return FCheckpointSourceControlChangelist(*Id, BranchName);
        }
      }
    }

    return FCheckpointSourceControlChangelist::DefaultFor(BranchName);
  }

  /** Whether a pending file belongs in a changelist at all. */
  bool IsSubmittable(const TSharedPtr<FJsonObject> &File) {
    bool bStaged = false;
    File->TryGetBoolField(TEXT("staged"), bStaged);
    int32 Status = 0;
    File->TryGetNumberField(TEXT("status"), Status);
    FCheckpointSourceControlState FileState(
      FString(), static_cast<ECheckpointFileStatus::Type>(Status)
    );
    return bStaged || FileState.CanCheckIn();
  }

  /** The changelist a command targets; none means Unreal's default one. */
  FCheckpointSourceControlChangelist CommandChangelist(
    const FCheckpointSourceControlCommand &InCommand
  ) {
    if (InCommand.Changelist.IsValid()) {
      return static_cast<const FCheckpointSourceControlChangelist &>(
        *InCommand.Changelist
      );
    }
    return FCheckpointSourceControlChangelist();
  }

  /** A daemon-relative path as the state cache keys it. */
  FString ToStateFilename(
    const FCheckpointSourceControlProvider &Provider, const FString &RelPath
  ) {
    FString AbsPath =
      FPaths::ConvertRelativePathToFull(Provider.ToAbsolutePath(RelPath));
    FPaths::NormalizeFilename(AbsPath);
    return AbsPath;
  }

  /**
   * Resolve a command's file to a workspace-relative path, reporting it when
   * it is outside the workspace root.
   */
  bool ToWorkspacePath(
    const FCheckpointSourceControlProvider &Provider,
    FCheckpointSourceControlCommand &InCommand,
    const FString &File,
    const TCHAR *Action,
    FString &OutRelPath
  ) {
    OutRelPath = Provider.ToRelativePath(File);
    if (OutRelPath.IsEmpty() || OutRelPath.StartsWith(TEXT("../")) ||
        OutRelPath.StartsWith(TEXT("/"))) {
      const FString Message = FString::Printf(
        TEXT("File '%s' is outside of the workspace root, cannot %s"),
        *File,
        Action
      );
      UE_LOG(LogCheckpointSourceControl, Warning, TEXT("%s"), *Message);
      InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Message));
      return false;
    }
    return true;
  }

  /** Log a failed daemon call and surface it to the editor. */
  void ReportFailure(
    FCheckpointSourceControlCommand &InCommand,
    const TCHAR *What,
    const FString &Error
  ) {
    UE_LOG(
      LogCheckpointSourceControl, Warning, TEXT("%s failed: %s"), What, *Error
    );
    InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Error));
  }
}

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

    // Branch is left empty so the claim lands on the workspace's domain
    // root, and exclusivity is decided by the repo's binary-extension set
    // rather than forced here: a .uasset is unmergeable and gets an exclusive
    // claim automatically.
    if (!Client.Checkout(
          Settings.GetDaemonId(),
          Settings.GetWorkspaceId(),
          RelPath,
          FString(),
          false,
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
  const FString &DomainBranchName = Settings.GetDomainBranchName();

  // No changelist means Unreal's default one, which is the domain root's.
  SubmittedChangelist = CommandChangelist(InCommand);

  // Build the modifications array from the files
  TArray<FString> SubmitPaths;

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

    // The daemon derives delete/modify from the file's own status, so only
    // the path is needed now.
    SubmitPaths.Add(RelPath);
    SubmittedFiles.Add(File);
  }

  // Get the description from the CheckIn operation
  TSharedRef<FCheckIn> CheckInOp =
    StaticCastSharedRef<FCheckIn>(InCommand.Operation);
  FString Description = CheckInOp->GetDescription().ToString();

  bool bKeepCheckedOut = CheckInOp->GetKeepCheckedOut();

  FString Error;

  // A numbered changelist is submitted whole by id, but a default one is
  // submitted from what is staged, and the Changelists window passes no
  // files. Gather what it shows (unstaged changes included) so they are
  // staged and go too.
  const bool bNeedsDescription = Description.IsEmpty();
  const bool bNeedsFiles =
    SubmitPaths.Num() == 0 && !SubmittedChangelist.IsNumbered();
  if (bNeedsDescription || bNeedsFiles) {
    FCheckpointPendingChangelists Changelists;
    if (!Client.ListChangelists(
          Settings.GetDaemonId(),
          Settings.GetWorkspaceId(),
          Changelists,
          Error
        )) {
      // An older daemon has no pending changelists, so everything is in a
      // branch default and there is no stored description to fall back on.
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("ListChangelists failed: %s"),
        *Error
      );
    }

    if (bNeedsDescription) {
      if (SubmittedChangelist.IsNumbered()) {
        if (const FCheckpointPendingChangelist *Changelist =
              Changelists.Find(SubmittedChangelist.GetId())) {
          Description = Changelist->Description;
        }
      } else {
        Description = Changelists.DefaultDescriptions.FindRef(ToDaemonBranch(
          SubmittedChangelist.GetBranchName(), DomainBranchName
        ));
      }
    }

    if (bNeedsFiles) {
      TMap<FString, TSharedPtr<FJsonObject>> PendingFiles;
      if (!Client.GetPendingFiles(
            Settings.GetDaemonId(),
            Settings.GetWorkspaceId(),
            PendingFiles,
            Error
          )) {
        ReportFailure(InCommand, TEXT("GetPendingFiles"), Error);
        return false;
      }

      for (const auto &Pair : PendingFiles) {
        if (IsSubmittable(Pair.Value) &&
            ChangelistOf(Pair.Key, Pair.Value, Changelists, DomainBranchName) ==
              SubmittedChangelist) {
          SubmitPaths.Add(Pair.Key);
          SubmittedFiles.Add(ToStateFilename(SccProvider, Pair.Key));
        }
      }
    }
  }

  if (Description.IsEmpty()) {
    Description = TEXT("Submitted from Unreal Engine");
  }

  if (!Client.Submit(
        Settings.GetDaemonId(),
        Settings.GetWorkspaceId(),
        Description,
        SubmitPaths,
        SubmittedChangelist.IsNumbered()
          ? FString()
          : SubmittedChangelist.GetBranchName(),
        bKeepCheckedOut,
        Error,
        SubmittedChangelist.GetId()
      )) {
    UE_LOG(
      LogCheckpointSourceControl, Error, TEXT("Submit failed: %s"), *Error
    );
    InCommand.ResultInfo.ErrorMessages.Add(FText::FromString(Error));
    return false;
  }

  bSubmitted = true;

  UE_LOG(
    LogCheckpointSourceControl,
    Log,
    TEXT("Successfully submitted changelist %s"),
    *SubmittedChangelist.GetIdentifier()
  );

  return true;
}

bool FCheckpointCheckInWorker::UpdateStates() {
  if (!bSubmitted) {
    return false;
  }

  auto &SccProvider = GetProvider();

  TArray<FString> Files = SubmittedFiles;
  auto ChangelistState =
    SccProvider.GetChangelistStateInternal(SubmittedChangelist);
  if (SubmittedChangelist.IsNumbered()) {
    // The daemon submitted everything in it, whatever the command listed.
    for (const FSourceControlStateRef &FileState : ChangelistState->Files) {
      Files.AddUnique(FileState->GetFilename());
    }
  }

  for (const FString &File : Files) {
    auto State = SccProvider.GetStateInternal(File);
    State->SetFileStatus(ECheckpointFileStatus::ReadOnlyControlled);
  }

  // A submitted numbered changelist is deleted by the daemon; a default one
  // stays, but loses its draft description.
  SccProvider.RemoveFilesFromChangelists(Files);
  if (SubmittedChangelist.IsNumbered()) {
    SccProvider.RemoveChangelistFromCache(SubmittedChangelist);
  } else {
    ChangelistState->Description.Empty();
  }

  SccProvider.BroadcastStateChanged();
  return true;
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
    // Reverted work has nothing left to submit. The next changelist update
    // puts back anything that still belongs in one (a file reverted from
    // Added to Local, say).
    SccProvider.RemoveFilesFromChangelists(RevertedFiles);
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

        // Claims held on this file. The daemon used to send `checkouts` with
        // a `locked` boolean; it now sends `claims`, and reading the old
        // shape silently left every file looking free, which let two artists
        // edit the same .uasset with no warning.
        const TArray<TSharedPtr<FJsonValue>> *Claims;
        if ((*Found)->TryGetArrayField(TEXT("claims"), Claims)) {
          for (const auto &ClaimVal : *Claims) {
            auto ClaimObj = ClaimVal->AsObject();
            if (!ClaimObj.IsValid()) continue;

            // `blocking` is the server's own answer to "does this stop me".
            // It already accounts for advisory-vs-exclusive and for claims
            // anchored in a sibling domain, which the editor cannot work out
            // for itself.
            bool bBlocking = false;
            ClaimObj->TryGetBoolField(TEXT("blocking"), bBlocking);

            const TSharedPtr<FJsonObject> *UserObj;
            if (ClaimObj->TryGetObjectField(TEXT("user"), UserObj)) {
              FString Email;
              (*UserObj)->TryGetStringField(TEXT("email"), Email);
              if (!Email.IsEmpty() && Email != SccProvider.GetUserEmail()) {
                FString UserName;
                (*UserObj)->TryGetStringField(TEXT("username"), UserName);
                FString Branch;
                ClaimObj->TryGetStringField(TEXT("branchName"), Branch);

                FString Display = UserName.IsEmpty() ? Email : UserName;
                if (!Branch.IsEmpty()) {
                  Display += FString::Printf(TEXT(" (on %s)"), *Branch);
                  ClaimBranches.Add(AbsFile, Branch);
                }
                OtherCheckouts.Add(AbsFile, Display);
              }
            }

            FString Strength;
            ClaimObj->TryGetStringField(TEXT("strength"), Strength);
            if (bBlocking && Strength == TEXT("EXCLUSIVE")) {
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
    if (FString *ClaimBranch = ClaimBranches.Find(Pair.Key)) {
      State->ClaimBranch = *ClaimBranch;
    }
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
  const FString &DomainBranchName = Settings.GetDomainBranchName();

  // The daemon reports every changelist in one call, so all of them are
  // rebuilt whichever ones were asked for.
  FString Error;
  FCheckpointPendingChangelists Changelists;
  if (!Client.ListChangelists(
        Settings.GetDaemonId(), Settings.GetWorkspaceId(), Changelists, Error
      )) {
    // An older daemon has no pending changelists. Everything is then in a
    // branch default, which is still worth showing.
    UE_LOG(
      LogCheckpointSourceControl,
      Warning,
      TEXT("ListChangelists failed: %s"),
      *Error
    );
  }

  auto AddDefault = [&](const FString &BranchName) {
    ChangelistDescriptions.Add(
      FCheckpointSourceControlChangelist::DefaultFor(BranchName),
      Changelists.DefaultDescriptions.FindRef(
        ToDaemonBranch(BranchName, DomainBranchName)
      )
    );
  };

  // The domain root and every active overlay can be submitted to, so each
  // has a default changelist even while it is empty.
  AddDefault(FString());
  for (const FString &BranchName : Settings.GetActiveBranches()) {
    AddDefault(ToChangelistBranch(BranchName, DomainBranchName));
  }

  for (const FCheckpointPendingChangelist &Changelist :
       Changelists.Changelists) {
    ChangelistDescriptions.Add(
      FCheckpointSourceControlChangelist(
        Changelist.Id,
        ToChangelistBranch(Changelist.BranchName, DomainBranchName)
      ),
      Changelist.Description
    );
  }

  // Get pending changes from the daemon via refresh
  if (Op->ShouldUpdateFilesStates()) {
    TMap<FString, TSharedPtr<FJsonObject>> PendingFiles;

    if (!Client.GetPendingFiles(
          Settings.GetDaemonId(), Settings.GetWorkspaceId(), PendingFiles, Error
        )) {
      // Still succeed: the changelists are known, just not their files.
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("GetPendingFiles failed: %s"),
        *Error
      );
    } else {
      bUpdatedFiles = true;

      for (const auto &Pair : PendingFiles) {
        if (!IsSubmittable(Pair.Value)) {
          continue;
        }

        FCheckpointSourceControlChangelist Changelist =
          ChangelistOf(Pair.Key, Pair.Value, Changelists, DomainBranchName);

        // A file can still be going to a branch that is no longer active.
        // List it in that branch's default rather than hide it.
        if (!ChangelistDescriptions.Contains(Changelist)) {
          AddDefault(Changelist.GetBranchName());
        }

        int32 Status = 0;
        Pair.Value->TryGetNumberField(TEXT("status"), Status);
        ChangelistFiles.FindOrAdd(Changelist).Add(
          ToStateFilename(SccProvider, Pair.Key),
          static_cast<ECheckpointFileStatus::Type>(Status)
        );
      }
    }
  }

  // Shelved files: not supported yet
  // When shelving support is added, ShouldUpdateShelvedFilesStates() will
  // be handled here.

  bUpdated = true;
  return true;
}

bool FCheckpointUpdateChangelistsStatusWorker::UpdateStates() {
  if (!bUpdated) {
    return false;
  }

  auto &SccProvider = GetProvider();
  const FDateTime Now = FDateTime::Now();

  TSet<FCheckpointSourceControlChangelist> Existing;
  for (const auto &Pair : ChangelistDescriptions) {
    Existing.Add(Pair.Key);

    auto ChangelistState = SccProvider.GetChangelistStateInternal(Pair.Key);
    ChangelistState->Changelist = Pair.Key;
    ChangelistState->Description = Pair.Value;
    ChangelistState->TimeStamp = Now;

    if (bUpdatedFiles) {
      // Clear and rebuild file list
      ChangelistState->Files.Empty();
      if (const auto *Files = ChangelistFiles.Find(Pair.Key)) {
        for (const auto &FilePair : *Files) {
          auto FileState = SccProvider.GetStateInternal(FilePair.Key);
          FileState->SetFileStatus(FilePair.Value);
          FileState->TimeStamp = Now;
          ChangelistState->Files.Add(FileState);
        }
      }
    }

    // Shelved files: empty for now
    ChangelistState->ShelvedFiles.Empty();
  }

  // Drop changelists submitted or deleted elsewhere (the desktop app, the
  // CLI) since the last update.
  SccProvider.PruneChangelistCache(Existing);

  // The Changelists window redraws from this broadcast, so it fires even
  // when every changelist is empty.
  SccProvider.BroadcastStateChanged();

  return true;
}

// ---- NewChangelist ----

bool FCheckpointNewChangelistWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();
  const FString &DomainBranchName = Settings.GetDomainBranchName();

  auto Op = StaticCastSharedRef<FNewChangelist>(InCommand.Operation);
  NewDescription = Op->GetDescription().ToString();

  TArray<FString> RelPaths;
  TArray<FString> Files;
  for (const FString &File : InCommand.Files) {
    FString RelPath;
    if (ToWorkspacePath(
          SccProvider, InCommand, File, TEXT("move to a changelist"), RelPath
        )) {
      RelPaths.Add(RelPath);
      Files.Add(File);
    }
  }

  FString Error;

  // A changelist submits to one branch, and staging into it moves each
  // file's claim there. Create it on the branch the files are already going
  // to, so that moving overlay work into a new changelist does not retarget
  // it to the domain root.
  FString BranchName;
  if (RelPaths.Num() > 0) {
    TMap<FString, TSharedPtr<FJsonObject>> PendingFiles;
    if (!Client.GetPendingFiles(
          Settings.GetDaemonId(), Settings.GetWorkspaceId(), PendingFiles, Error
        )) {
      ReportFailure(InCommand, TEXT("GetPendingFiles"), Error);
      return false;
    }

    bool bFoundBranch = false;
    for (const FString &RelPath : RelPaths) {
      const TSharedPtr<FJsonObject> *File = PendingFiles.Find(RelPath);
      if (!File) {
        // Nothing pending, so nothing pins it to a branch.
        continue;
      }
      const FString FileBranch = DestinedBranch(*File, DomainBranchName);
      if (!bFoundBranch) {
        BranchName = FileBranch;
        bFoundBranch = true;
      } else if (FileBranch != BranchName) {
        ReportFailure(
          InCommand,
          TEXT("NewChangelist"),
          TEXT("These files are going to different branches, so they cannot ")
          TEXT("share one changelist.")
        );
        return false;
      }
    }
  }

  FCheckpointPendingChangelist Created;
  if (!Client.CreateChangelist(
        Settings.GetDaemonId(),
        Settings.GetWorkspaceId(),
        NewDescription,
        BranchName,
        Created,
        Error
      )) {
    ReportFailure(InCommand, TEXT("CreateChangelist"), Error);
    return false;
  }

  NewChangelist = FCheckpointSourceControlChangelist(
    Created.Id, ToChangelistBranch(Created.BranchName, DomainBranchName)
  );

  if (RelPaths.Num() > 0) {
    if (!Client.Stage(
          Settings.GetDaemonId(),
          Settings.GetWorkspaceId(),
          RelPaths,
          FString(),
          Created.Id,
          Error
        )) {
      ReportFailure(InCommand, TEXT("Stage"), Error);

      // Do not leave an empty changelist behind for a move that failed, as
      // the Perforce provider does.
      FString DeleteError;
      Client.DeleteChangelist(
        Settings.GetDaemonId(),
        Settings.GetWorkspaceId(),
        Created.Id,
        DeleteError
      );
      return false;
    }
    MovedFiles = Files;
  }

  Op->SetNewChangelist(
    MakeShared<FCheckpointSourceControlChangelist, ESPMode::ThreadSafe>(
      NewChangelist
    )
  );
  bCreated = true;
  return true;
}

bool FCheckpointNewChangelistWorker::UpdateStates() {
  if (!bCreated) {
    return false;
  }

  auto &SccProvider = GetProvider();
  auto ChangelistState = SccProvider.GetChangelistStateInternal(NewChangelist);
  ChangelistState->Description = NewDescription;
  ChangelistState->TimeStamp = FDateTime::Now();

  if (MovedFiles.Num() > 0) {
    SccProvider.MoveFilesToChangelist(MovedFiles, NewChangelist);
  }

  SccProvider.BroadcastStateChanged();
  return true;
}

// ---- DeleteChangelist ----

bool FCheckpointDeleteChangelistWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  DeletedChangelist = CommandChangelist(InCommand);
  if (!DeletedChangelist.IsNumbered()) {
    ReportFailure(
      InCommand,
      TEXT("DeleteChangelist"),
      TEXT("A branch's default changelist cannot be deleted.")
    );
    return false;
  }

  FString Error;
  if (!Client.DeleteChangelist(
        Settings.GetDaemonId(),
        Settings.GetWorkspaceId(),
        DeletedChangelist.GetId(),
        Error
      )) {
    ReportFailure(InCommand, TEXT("DeleteChangelist"), Error);
    return false;
  }

  bDeleted = true;
  return true;
}

bool FCheckpointDeleteChangelistWorker::UpdateStates() {
  if (!bDeleted) {
    return false;
  }

  auto &SccProvider = GetProvider();

  // Its files stay staged and fall back to their branch's default changelist.
  TArray<FString> Files;
  auto ChangelistState =
    SccProvider.GetChangelistStateInternal(DeletedChangelist);
  for (const FSourceControlStateRef &FileState : ChangelistState->Files) {
    Files.Add(FileState->GetFilename());
  }

  SccProvider.RemoveChangelistFromCache(DeletedChangelist);
  if (Files.Num() > 0) {
    SccProvider.MoveFilesToChangelist(
      Files,
      FCheckpointSourceControlChangelist::DefaultFor(
        DeletedChangelist.GetBranchName()
      )
    );
  }

  SccProvider.BroadcastStateChanged();
  return true;
}

// ---- EditChangelist ----

bool FCheckpointEditChangelistWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  auto Op = StaticCastSharedRef<FEditChangelist>(InCommand.Operation);
  EditedChangelist = CommandChangelist(InCommand);
  EditedDescription = Op->GetDescription().ToString();

  // A numbered changelist is addressed by id, a default one by its branch
  // (empty lets the daemon pick the domain root).
  FString Error;
  if (!Client.SetChangelistDescription(
        Settings.GetDaemonId(),
        Settings.GetWorkspaceId(),
        EditedDescription,
        EditedChangelist.GetId(),
        EditedChangelist.IsNumbered() ? FString()
                                      : EditedChangelist.GetBranchName(),
        Error
      )) {
    ReportFailure(InCommand, TEXT("SetChangelistDescription"), Error);
    return false;
  }

  bEdited = true;
  return true;
}

bool FCheckpointEditChangelistWorker::UpdateStates() {
  if (!bEdited) {
    return false;
  }

  auto &SccProvider = GetProvider();
  auto ChangelistState =
    SccProvider.GetChangelistStateInternal(EditedChangelist);
  ChangelistState->Description = EditedDescription;
  ChangelistState->TimeStamp = FDateTime::Now();

  SccProvider.BroadcastStateChanged();
  return true;
}

// ---- MoveToChangelist ----

bool FCheckpointMoveToChangelistWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  auto &SccProvider = GetProvider();
  auto &Client = SccProvider.GetDaemonClient();
  auto &Settings = SccProvider.AccessSettings();

  DestinationChangelist = CommandChangelist(InCommand);

  TArray<FString> RelPaths;
  TArray<FString> Files;
  for (const FString &File : InCommand.Files) {
    FString RelPath;
    if (ToWorkspacePath(
          SccProvider, InCommand, File, TEXT("move to a changelist"), RelPath
        )) {
      RelPaths.Add(RelPath);
      Files.Add(File);
    }
  }

  if (RelPaths.Num() == 0) {
    return InCommand.ResultInfo.ErrorMessages.Num() == 0;
  }

  // Staging is what puts a file in a changelist. It also moves the file's
  // claim to the changelist's branch, so the work is submitted wherever the
  // changelist goes.
  FString Error;
  if (!Client.Stage(
        Settings.GetDaemonId(),
        Settings.GetWorkspaceId(),
        RelPaths,
        DestinationChangelist.IsNumbered()
          ? FString()
          : DestinationChangelist.GetBranchName(),
        DestinationChangelist.GetId(),
        Error
      )) {
    ReportFailure(InCommand, TEXT("Stage"), Error);
    return false;
  }

  MovedFiles = Files;
  return InCommand.ResultInfo.ErrorMessages.Num() == 0;
}

bool FCheckpointMoveToChangelistWorker::UpdateStates() {
  if (MovedFiles.Num() == 0) {
    return false;
  }

  auto &SccProvider = GetProvider();
  SccProvider.MoveFilesToChangelist(MovedFiles, DestinationChangelist);
  SccProvider.BroadcastStateChanged();
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

  Register(
    TEXT("NewChangelist"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointNewChangelistWorker(P));
    }
  );

  Register(
    TEXT("DeleteChangelist"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointDeleteChangelistWorker(P));
    }
  );

  Register(
    TEXT("EditChangelist"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointEditChangelistWorker(P));
    }
  );

  Register(
    TEXT("MoveToChangelist"),
    [](FCheckpointSourceControlProvider &P) -> FCheckpointWorkerRef {
      return MakeShareable(new FCheckpointMoveToChangelistWorker(P));
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
