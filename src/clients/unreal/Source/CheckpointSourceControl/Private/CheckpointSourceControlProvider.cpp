// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointSourceControlProvider.h"

#include "CheckpointSourceControlCommand.h"
#include "CheckpointSourceControlModule.h"
#include "CheckpointSourceControlOperations.h"
#include "ISourceControlModule.h"
#include "Misc/Paths.h"
#include "SourceControlOperations.h"

#if SOURCE_CONTROL_WITH_SLATE
  #include "SCheckpointSourceControlSettings.h"
#endif

// Forward declaration from operations cpp
extern TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
CreateCheckpointWorker(
  const FName &InOperationName, FCheckpointSourceControlProvider &Provider
);

FCheckpointSourceControlProvider::FCheckpointSourceControlProvider() :
  bServerAvailable(false) {}

void FCheckpointSourceControlProvider::Init(bool bForceConnection) {
  // Try to resolve all settings from JSON config files
  bool bSettingsOk = Settings.LoadFromConfigFiles();
  DaemonClient.SetDaemonUrl(Settings.GetDaemonUrl());

  if (bForceConnection && bSettingsOk) {
    // Verify the daemon is reachable and get the user
    FString Error;
    TSharedPtr<FJsonObject> UserObj;

    if (DaemonClient.GetUser(Settings.GetDaemonId(), UserObj, Error)) {
      bServerAvailable = true;

      if (UserObj.IsValid()) {
        UserObj->TryGetStringField(TEXT("email"), UserEmail);
        UserObj->TryGetStringField(TEXT("name"), UserName);
      }

      WorkspaceName = Settings.GetWorkspaceName();

      UE_LOG(
        LogCheckpointSourceControl,
        Log,
        TEXT(
          "Connected to Checkpoint daemon as %s, "
          "workspace: %s"
        ),
        *UserEmail,
        *WorkspaceName
      );
    } else {
      bServerAvailable = false;
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("Failed to connect to Checkpoint daemon: %s"),
        *Error
      );
    }
  } else if (bForceConnection) {
    bServerAvailable = false;
    UE_LOG(
      LogCheckpointSourceControl,
      Log,
      TEXT(
        "Checkpoint: No workspace configured yet — "
        "use the settings dialog to create one"
      )
    );
  }
}

void FCheckpointSourceControlProvider::Close() {
  bServerAvailable = false;
  StateCache.Empty();
  CommandQueue.Empty();
  UserEmail.Empty();
  UserName.Empty();
  WorkspaceName.Empty();
}

const FName &FCheckpointSourceControlProvider::GetName() const {
  static FName ProviderName("Checkpoint");
  return ProviderName;
}

FText FCheckpointSourceControlProvider::GetStatusText() const {
  if (bServerAvailable) {
    if (!WorkspaceName.IsEmpty()) {
      return FText::Format(
        NSLOCTEXT(
          "CheckpointSC",
          "StatusConnected",
          "Connected to Checkpoint - {0} ({1})"
        ),
        FText::FromString(WorkspaceName),
        FText::FromString(UserEmail)
      );
    }
    return FText::Format(
      NSLOCTEXT(
        "CheckpointSC", "StatusConnectedNoWs", "Connected to Checkpoint ({0})"
      ),
      FText::FromString(UserEmail)
    );
  }
  return NSLOCTEXT(
    "CheckpointSC", "StatusNotConnected", "Not connected to Checkpoint daemon"
  );
}

TMap<ISourceControlProvider::EStatus, FString>
FCheckpointSourceControlProvider::GetStatus() const {
  TMap<EStatus, FString> Result;
  Result.Add(EStatus::Enabled, IsEnabled() ? TEXT("Yes") : TEXT("No"));
  Result.Add(EStatus::Connected, bServerAvailable ? TEXT("Yes") : TEXT("No"));
  Result.Add(EStatus::User, UserEmail);
  Result.Add(EStatus::Workspace, WorkspaceName);
  Result.Add(EStatus::WorkspacePath, Settings.GetWorkspacePath());
  Result.Add(EStatus::Port, FString::FromInt(Settings.GetDaemonPort()));
  return Result;
}

bool FCheckpointSourceControlProvider::IsEnabled() const {
  return true;
}

bool FCheckpointSourceControlProvider::IsAvailable() const {
  return bServerAvailable;
}

bool FCheckpointSourceControlProvider::QueryStateBranchConfig(
  const FString &ConfigSrc, const FString &ConfigDest
) {
  // Checkpoint doesn't use branch configuration files
  return false;
}

void FCheckpointSourceControlProvider::RegisterStateBranches(
  const TArray<FString> &BranchNames, const FString &ContentRoot
) {
  // Branches not supported yet
}

int32 FCheckpointSourceControlProvider::GetStateBranchIndex(
  const FString &BranchName
) const {
  return INDEX_NONE;
}

bool FCheckpointSourceControlProvider::GetStateBranchAtIndex(
  int32 BranchIndex, FString &OutBranchName
) const {
  return false;
}

ECommandResult::Type FCheckpointSourceControlProvider::GetState(
  const TArray<FString> &InFiles,
  TArray<FSourceControlStateRef> &OutState,
  EStateCacheUsage::Type InStateCacheUsage
) {
  if (InStateCacheUsage == EStateCacheUsage::ForceUpdate) {
    // Force update by making an UpdateStatus call
    TSharedRef<FUpdateStatus> UpdateOp =
      ISourceControlOperation::Create<FUpdateStatus>();

    Execute(
      UpdateOp,
      FSourceControlChangelistPtr(),
      InFiles,
      EConcurrency::Synchronous,
      FSourceControlOperationComplete()
    );
  }

  // Return cached states
  for (const FString &File : InFiles) {
    FString CleanFile = FPaths::ConvertRelativePathToFull(File);
    FPaths::NormalizeFilename(CleanFile);

    // check if the file is in a child directory of the workspace root, if not return an unknown state
    if (!CleanFile.StartsWith(Settings.GetWorkspacePath())) {
      TSharedRef<FCheckpointSourceControlState> UnknownState =
        MakeShareable(new FCheckpointSourceControlState(CleanFile));
      OutState.Add(UnknownState);
      continue;
    }

    TSharedRef<FCheckpointSourceControlState, ESPMode::ThreadSafe>
      *CachedState = StateCache.Find(CleanFile);

    if (CachedState) {
      OutState.Add(*CachedState);
    } else {
      // Create a default unknown state
      TSharedRef<FCheckpointSourceControlState> NewState =
        MakeShareable(new FCheckpointSourceControlState(CleanFile));
      StateCache.Add(CleanFile, NewState);
      OutState.Add(NewState);
    }
  }

  return ECommandResult::Succeeded;
}

ECommandResult::Type FCheckpointSourceControlProvider::GetState(
  const TArray<FSourceControlChangelistRef> &InChangelists,
  TArray<FSourceControlChangelistStateRef> &OutState,
  EStateCacheUsage::Type InStateCacheUsage
) {
  if (InStateCacheUsage == EStateCacheUsage::ForceUpdate) {
    TSharedRef<FUpdatePendingChangelistsStatus, ESPMode::ThreadSafe> UpdateOp =
      ISourceControlOperation::Create<FUpdatePendingChangelistsStatus>();
    UpdateOp->SetChangelistsToUpdate(InChangelists);
    ISourceControlProvider::Execute(UpdateOp, EConcurrency::Synchronous);
  }

  for (const FSourceControlChangelistRef &Changelist : InChangelists) {
    const FCheckpointSourceControlChangelist &CheckpointCL =
      static_cast<const FCheckpointSourceControlChangelist &>(Changelist.Get());
    OutState.Add(GetChangelistStateInternal(CheckpointCL));
  }

  return ECommandResult::Succeeded;
}

TArray<FSourceControlStateRef>
FCheckpointSourceControlProvider::GetCachedStateByPredicate(
  TFunctionRef<bool(const FSourceControlStateRef &)> Predicate
) const {
  TArray<FSourceControlStateRef> Result;
  for (const auto &Pair : StateCache) {
    FSourceControlStateRef StateRef = Pair.Value;
    if (Predicate(StateRef)) {
      Result.Add(StateRef);
    }
  }
  return Result;
}

FDelegateHandle
FCheckpointSourceControlProvider::RegisterSourceControlStateChanged_Handle(
  const FSourceControlStateChanged::FDelegate &SourceControlStateChanged
) {
  return OnSourceControlStateChanged.Add(SourceControlStateChanged);
}

void FCheckpointSourceControlProvider::
  UnregisterSourceControlStateChanged_Handle(FDelegateHandle Handle) {
  OnSourceControlStateChanged.Remove(Handle);
}

ECommandResult::Type FCheckpointSourceControlProvider::Execute(
  const FSourceControlOperationRef &InOperation,
  FSourceControlChangelistPtr InChangelist,
  const TArray<FString> &InFiles,
  EConcurrency::Type InConcurrency,
  const FSourceControlOperationComplete &InOperationCompleteDelegate
) {
  if (!IsEnabled()) {
    InOperationCompleteDelegate.ExecuteIfBound(
      InOperation, ECommandResult::Failed
    );
    return ECommandResult::Failed;
  }

  // Create a worker for this operation
  TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe> Worker =
    CreateWorker(InOperation->GetName());

  if (!Worker.IsValid()) {
    UE_LOG(
      LogCheckpointSourceControl,
      Warning,
      TEXT("Operation '%s' not supported"),
      *InOperation->GetName().ToString()
    );
    InOperationCompleteDelegate.ExecuteIfBound(
      InOperation, ECommandResult::Failed
    );
    return ECommandResult::Failed;
  }

  // Create the command
  auto *Command = new FCheckpointSourceControlCommand(
    InOperation, Worker.ToSharedRef(), InOperationCompleteDelegate
  );
  Command->Concurrency = InConcurrency;
  Command->Changelist = InChangelist;

  // Normalize file paths
  for (const FString &File : InFiles) {
    FString CleanFile = FPaths::ConvertRelativePathToFull(File);
    FPaths::NormalizeFilename(CleanFile);
    Command->Files.Add(CleanFile);
  }

  return IssueCommand(*Command);
}

bool FCheckpointSourceControlProvider::CanExecuteOperation(
  const FSourceControlOperationRef &InOperation
) const {
  TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe> Worker =
    CreateWorker(InOperation->GetName());
  return Worker.IsValid();
}

bool FCheckpointSourceControlProvider::CanCancelOperation(
  const FSourceControlOperationRef &InOperation
) const {
  return false;
}

void FCheckpointSourceControlProvider::CancelOperation(
  const FSourceControlOperationRef &InOperation
) {
  // Cancel not supported
}

TArray<TSharedRef<class ISourceControlLabel>>
FCheckpointSourceControlProvider::GetLabels(
  const FString &InMatchingSpec
) const {
  // Labels could be mapped to Checkpoint labels but
  // the interface doesn't align well. Return empty for now.
  return TArray<TSharedRef<ISourceControlLabel>>();
}

TArray<FSourceControlChangelistRef>
FCheckpointSourceControlProvider::GetChangelists(
  EStateCacheUsage::Type InStateCacheUsage
) {
  if (!IsEnabled()) {
    return TArray<FSourceControlChangelistRef>();
  }

  if (InStateCacheUsage == EStateCacheUsage::ForceUpdate) {
    TSharedRef<FUpdatePendingChangelistsStatus, ESPMode::ThreadSafe> UpdateOp =
      ISourceControlOperation::Create<FUpdatePendingChangelistsStatus>();
    UpdateOp->SetUpdateAllChangelists(true);
    ISourceControlProvider::Execute(UpdateOp, EConcurrency::Synchronous);
  }

  TArray<FSourceControlChangelistRef> Changelists;
  for (const auto &Pair : ChangelistsStateCache) {
    Changelists.Add(
      MakeShared<FCheckpointSourceControlChangelist, ESPMode::ThreadSafe>(
        Pair.Key
      )
    );
  }

  return Changelists;
}

bool FCheckpointSourceControlProvider::UsesLocalReadOnlyState() const {
  // TODO MIKE HERE: Checkpoint has a FileStatus to indicate if a file is read-only,
  // but we don't have a "sync files as read-only" mode like Perforce/Plastic. When
  // That gets added, we should check the workspace config to see if this is enabled
  // (because it'll be a workspace setting).
  return false;
}

bool FCheckpointSourceControlProvider::UsesChangelists() const {
  // TODO MIKE HERE: While Checkpoint has the concept of changelists,
  // we currently use them like commits (e.g. they have been pushed to a branch and are immutable)
  // This setting is for creating changelists prior to submit, which we don't support yet.
  // This likely would get supported when we introduce shelve.
  return false;
}

bool FCheckpointSourceControlProvider::UsesUncontrolledChangelists() const {
  return false;
}

bool FCheckpointSourceControlProvider::UsesCheckout() const {
  return true;
}

bool FCheckpointSourceControlProvider::UsesFileRevisions() const {
  return true;
}

bool FCheckpointSourceControlProvider::UsesSnapshots() const {
  return false;
}

bool FCheckpointSourceControlProvider::AllowsDiffAgainstDepot() const {
  return true;
}

TOptional<bool> FCheckpointSourceControlProvider::IsAtLatestRevision() const {
  // Could be implemented by comparing local changelist number
  // to the head changelist. Not implemented yet.
  return TOptional<bool>();
}

TOptional<int> FCheckpointSourceControlProvider::GetNumLocalChanges() const {
  // Could count items in state cache that are modified
  int32 Count = 0;
  for (const auto &Pair : StateCache) {
    if (Pair.Value->IsModified()) {
      Count++;
    }
  }
  return Count;
}

void FCheckpointSourceControlProvider::Tick() {
  // Process completed async commands
  for (int32 i = CommandQueue.Num() - 1; i >= 0; --i) {
    FCheckpointSourceControlCommand *Command = CommandQueue[i];
    if (Command->bExecuteProcessed) {
      CommandQueue.RemoveAt(i);
      Command->ReturnResults();
      if (Command->bAutoDelete) {
        delete Command;
      }
    }
  }
}

#if SOURCE_CONTROL_WITH_SLATE
TSharedRef<class SWidget> FCheckpointSourceControlProvider::MakeSettingsWidget(
) const {
  return SNew(
    SCheckpointSourceControlSettings,
    const_cast<FCheckpointSourceControlProvider *>(this)
  );
}
#endif

// ---- Internal methods ----

TSharedRef<FCheckpointSourceControlState, ESPMode::ThreadSafe>
FCheckpointSourceControlProvider::GetStateInternal(const FString &InFilename) {
  FString CleanFilename = FPaths::ConvertRelativePathToFull(InFilename);
  FPaths::NormalizeFilename(CleanFilename);

  TSharedRef<FCheckpointSourceControlState, ESPMode::ThreadSafe>
    *ExistingState = StateCache.Find(CleanFilename);

  if (ExistingState) {
    return *ExistingState;
  }

  TSharedRef<FCheckpointSourceControlState> NewState =
    MakeShareable(new FCheckpointSourceControlState(CleanFilename));
  StateCache.Add(CleanFilename, NewState);
  return NewState;
}

TSharedRef<FCheckpointSourceControlChangelistState, ESPMode::ThreadSafe>
FCheckpointSourceControlProvider::GetChangelistStateInternal(
  const FCheckpointSourceControlChangelist &InChangelist
) {
  TSharedRef<FCheckpointSourceControlChangelistState, ESPMode::ThreadSafe>
    *ExistingState = ChangelistsStateCache.Find(InChangelist);

  if (ExistingState) {
    return *ExistingState;
  }

  TSharedRef<FCheckpointSourceControlChangelistState> NewState =
    MakeShareable(new FCheckpointSourceControlChangelistState(InChangelist));
  ChangelistsStateCache.Add(InChangelist, NewState);
  return NewState;
}

FString FCheckpointSourceControlProvider::ToRelativePath(
  const FString &AbsolutePath
) const {
  FString WorkspaceRoot = Settings.GetWorkspacePath();
  if (WorkspaceRoot.IsEmpty()) {
    return AbsolutePath;
  }

  FString NormalizedAbs = AbsolutePath;
  FString NormalizedRoot = WorkspaceRoot;

  FPaths::NormalizeDirectoryName(NormalizedAbs);
  FPaths::NormalizeDirectoryName(NormalizedRoot);

  // Ensure root ends with separator
  if (!NormalizedRoot.EndsWith(TEXT("/"))) {
    NormalizedRoot += TEXT("/");
  }

  if (NormalizedAbs.StartsWith(NormalizedRoot)) {
    return NormalizedAbs.Mid(NormalizedRoot.Len());
  }

  // Fall back to relative path computation
  FString RelPath = NormalizedAbs;
  FPaths::MakePathRelativeTo(RelPath, *NormalizedRoot);
  return RelPath;
}

FString FCheckpointSourceControlProvider::ToAbsolutePath(
  const FString &RelPath
) const {
  FString WorkspaceRoot = Settings.GetWorkspacePath();
  if (WorkspaceRoot.IsEmpty()) {
    return RelPath;
  }
  return FPaths::Combine(WorkspaceRoot, RelPath);
}

TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
FCheckpointSourceControlProvider::CreateWorker(
  const FName &InOperationName
) const {
  return CreateCheckpointWorker(
    InOperationName, *const_cast<FCheckpointSourceControlProvider *>(this)
  );
}

ECommandResult::Type
FCheckpointSourceControlProvider::ExecuteSynchronousCommand(
  FCheckpointSourceControlCommand &InCommand, const FText &InTask
) {
  InCommand.DoWork();
  return InCommand.ReturnResults();
}

ECommandResult::Type FCheckpointSourceControlProvider::IssueCommand(
  FCheckpointSourceControlCommand &InCommand
) {
  if (InCommand.Concurrency == EConcurrency::Synchronous) {
    return ExecuteSynchronousCommand(
      InCommand, InCommand.Operation->GetInProgressString()
    );
  } else {
    // For async, queue and process in Tick
    InCommand.bAutoDelete = true;
    CommandQueue.Add(&InCommand);

    // Start execution on a separate thread
    Async(EAsyncExecution::ThreadPool, [&InCommand]() { InCommand.DoWork(); });

    return ECommandResult::Succeeded;
  }
}
