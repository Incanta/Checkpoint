// Copyright (c) 2014-2023 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#include "CheckpointSourceControlProvider.h"

#include "CheckpointMacros.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Async/Async.h"
#include "CheckpointMessageLog.h"
#include "CheckpointSourceControlChangelistState.h"
#include "CheckpointSourceControlCommand.h"
#include "CheckpointSourceControlModule.h"
#include "CheckpointSourceControlRunner.h"
#include "GenericPlatform/GenericPlatformFile.h"
#include "HAL/FileManager.h"
#include "ISourceControlModule.h"
#include "Interfaces/IPluginManager.h"
#include "Logging/MessageLog.h"
#include "Misc/App.h"
#include "Misc/EngineVersion.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Misc/QueuedThreadPool.h"
#include "SCheckpointSourceControlSettings.h"
#include "ScopedSourceControlProgress.h"
#include "SourceControlHelpers.h"
#include "SourceControlOperations.h"

#include "Runtime/Launch/Resources/Version.h"
#include "UObject/ObjectSaveContext.h"

#include "UObject/Package.h"

#define LOCTEXT_NAMESPACE "CheckpointSourceControl"

static FName ProviderName("Checkpoint");

void FCheckpointSourceControlProvider::Init(bool bForceConnection) {
  // Init() is called multiple times at startup, so only do this once
  if (!bInit) {
    const TSharedPtr<IPlugin> Plugin =
      IPluginManager::Get().FindPlugin(TEXT("CheckpointSourceControl"));
    if (Plugin.IsValid()) {
      UE_LOG(
        LogSourceControl,
        Log,
        TEXT("Checkpoint VCS plugin '%s'"),
        *(Plugin->GetDescriptor().VersionName)
      );
    }
  }

  bInit = true;
}

void FCheckpointSourceControlProvider::SetLastErrors(
  const TArray<FText> &InErrors
) {
  FScopeLock Lock(&LastErrorsCriticalSection);
  LastErrors = InErrors;
}

TArray<FText> FCheckpointSourceControlProvider::GetLastErrors() const {
  FScopeLock Lock(&LastErrorsCriticalSection);
  TArray<FText> Result = LastErrors;
  return Result;
}

int32 FCheckpointSourceControlProvider::GetNumLastErrors() const {
  FScopeLock Lock(&LastErrorsCriticalSection);
  return LastErrors.Num();
}

void FCheckpointSourceControlProvider::Close() {
  // clear the cache
  StateCache.Empty();

  bInit = false;
  if (Runner) {
    delete Runner;
    Runner = nullptr;
  }
}

FText FCheckpointSourceControlProvider::GetStatusText() const {
  FFormatNamedArguments Args;
  Args.Add(
    TEXT("IsAvailable"),
    (IsEnabled() && IsAvailable()) ? LOCTEXT("Yes", "Yes") : LOCTEXT("No", "No")
  );
  Args.Add(TEXT("RepositoryName"), FText::FromString(PathToWorkspaceRoot));
  Args.Add(TEXT("RemoteUrl"), FText::FromString(RemoteUrl));
  Args.Add(TEXT("BranchName"), FText::FromString(BranchName));

  FText FormattedError;
  const TArray<FText> &RecentErrors = GetLastErrors();
  if (RecentErrors.Num() > 0) {
    FFormatNamedArguments ErrorArgs;
    ErrorArgs.Add(TEXT("ErrorText"), RecentErrors[0]);

    FormattedError = FText::Format(
      LOCTEXT("CheckpointErrorStatusText", "Error: {ErrorText}\n\n"), ErrorArgs
    );
  }

  Args.Add(TEXT("ErrorText"), FormattedError);

  return FText::Format(
    NSLOCTEXT(
      "CheckpointStatusText",
      "{ErrorText}Enabled: {IsAvailable}",
      "Local repository: {RepositoryName}\nRemote: {RemoteUrl}\nUser: {UserName}\nE-mail: {UserEmail}\n[{BranchName} {CommitId}] {CommitSummary}"
    ),
    Args
  );
}

/** Quick check if revision control is enabled */
bool FCheckpointSourceControlProvider::IsEnabled() const {
  return bInit;
}

/** Quick check if revision control is available for use (useful for server-based providers) */
bool FCheckpointSourceControlProvider::IsAvailable() const {
  return bInit;
}

const FName &FCheckpointSourceControlProvider::GetName(void) const {
  return ProviderName;
}

ECommandResult::Type FCheckpointSourceControlProvider::GetState(
  const TArray<FString> &InFiles,
  TArray<TSharedRef<ISourceControlState, ESPMode::ThreadSafe>> &OutState,
  EStateCacheUsage::Type InStateCacheUsage
) {
  if (!IsEnabled()) {
    return ECommandResult::Failed;
  }

  if (InStateCacheUsage == EStateCacheUsage::ForceUpdate) {
    TArray<FString> ForceUpdate;
    for (FString Path : InFiles) {
      // Remove the path from the cache, so it's not ignored the next time we force check.
      // If the file isn't in the cache, force update it now.
      if (!RemoveFileFromIgnoreForceCache(Path)) {
        ForceUpdate.Add(Path);
      }
    }
    if (ForceUpdate.Num() > 0) {
      Execute(ISourceControlOperation::Create<FUpdateStatus>(), ForceUpdate);
    }
  }

  // const TArray<FString> &AbsoluteFiles =
  //   SourceControlHelpers::AbsoluteFilenames(InFiles);

  // for (TArray<FString>::TConstIterator It(AbsoluteFiles); It; It++) {
  //   OutState.Add(GetStateInternal(*It));
  // }

  return ECommandResult::Succeeded;
}

ECommandResult::Type FCheckpointSourceControlProvider::GetState(
  const TArray<FSourceControlChangelistRef> &InChangelists,
  TArray<FSourceControlChangelistStateRef> &OutState,
  EStateCacheUsage::Type InStateCacheUsage
) {
  if (!IsEnabled()) {
    return ECommandResult::Failed;
  }

  // for (FSourceControlChangelistRef Changelist : InChangelists) {
  //   FCheckpointSourceControlChangelistRef Changelist =
  //     StaticCastSharedRef<FCheckpointSourceControlChangelist>(Changelist);
  //   OutState.Add(GetStateInternal(Changelist.Get()));
  // }
  return ECommandResult::Succeeded;
}

TArray<FSourceControlStateRef>
FCheckpointSourceControlProvider::GetCachedStateByPredicate(
  TFunctionRef<bool(const FSourceControlStateRef &)> Predicate
) const {
  TArray<FSourceControlStateRef> Result;
  // for (const auto &CacheItem : StateCache) {
  //   const FSourceControlStateRef &State = CacheItem.Value;
  //   if (Predicate(State)) {
  //     Result.Add(State);
  //   }
  // }
  return Result;
}

bool FCheckpointSourceControlProvider::RemoveFileFromCache(
  const FString &Filename
) {
  return StateCache.Remove(Filename) > 0;
}

bool FCheckpointSourceControlProvider::AddFileToIgnoreForceCache(
  const FString &Filename
) {
  return IgnoreForceCache.Add(Filename) > 0;
}

bool FCheckpointSourceControlProvider::RemoveFileFromIgnoreForceCache(
  const FString &Filename
) {
  return IgnoreForceCache.Remove(Filename) > 0;
}

/** Get files in cache */
TArray<FString> FCheckpointSourceControlProvider::GetFilesInCache() {
  TArray<FString> Files;
  for (const auto &State : StateCache) {
    Files.Add(State.Key);
  }
  return Files;
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
  if (!IsEnabled() &&
      !(InOperation->GetName() == "Connect"
      )) // Only Connect operation allowed while not Enabled (Repository found)
  {
    InOperationCompleteDelegate.ExecuteIfBound(
      InOperation, ECommandResult::Failed
    );
    return ECommandResult::Failed;
  }

  TArray<FString> AbsoluteFiles =
    SourceControlHelpers::AbsoluteFilenames(InFiles);

  // Query to see if we allow this operation
  TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe> Worker =
    CreateWorker(InOperation->GetName());
  if (!Worker.IsValid()) {
    // this operation is unsupported by this revision control provider
    FFormatNamedArguments Arguments;
    Arguments.Add(
      TEXT("OperationName"), FText::FromName(InOperation->GetName())
    );
    Arguments.Add(TEXT("ProviderName"), FText::FromName(GetName()));
    FText Message(
      FText::Format(
        LOCTEXT(
          "UnsupportedOperation",
          "Operation '{OperationName}' not supported by revision control provider '{ProviderName}'"
        ),
        Arguments
      )
    );

    FTSMessageLog("SourceControl").Error(Message);
    InOperation->AddErrorMessge(Message);

    InOperationCompleteDelegate.ExecuteIfBound(
      InOperation, ECommandResult::Failed
    );
    return ECommandResult::Failed;
  }

  FCheckpointSourceControlCommand *Command =
    new FCheckpointSourceControlCommand(InOperation, Worker.ToSharedRef());
  Command->Files = AbsoluteFiles;
  Command->OperationCompleteDelegate = InOperationCompleteDelegate;

  TSharedPtr<FCheckpointSourceControlChangelist, ESPMode::ThreadSafe>
    ChangelistPtr =
      StaticCastSharedPtr<FCheckpointSourceControlChangelist>(InChangelist);
  Command->Changelist = ChangelistPtr ? ChangelistPtr.ToSharedRef().Get()
                                      : FCheckpointSourceControlChangelist();

  // fire off operation
  if (InConcurrency == EConcurrency::Synchronous) {
    Command->bAutoDelete = false;

#if UE_BUILD_DEBUG
    UE_LOG(
      LogSourceControl,
      Log,
      TEXT("ExecuteSynchronousCommand(%s)"),
      *InOperation->GetName().ToString()
    );
#endif
    return ExecuteSynchronousCommand(
      *Command, InOperation->GetInProgressString(), false
    );
  } else {
    Command->bAutoDelete = true;

#if UE_BUILD_DEBUG
    UE_LOG(
      LogSourceControl,
      Log,
      TEXT("IssueAsynchronousCommand(%s)"),
      *InOperation->GetName().ToString()
    );
#endif
    return IssueCommand(*Command);
  }
}

bool FCheckpointSourceControlProvider::CanCancelOperation(
  const FSourceControlOperationRef &InOperation
) const {
  // TODO: maybe support cancellation again?
#if 0
	for (int32 CommandIndex = 0; CommandIndex < CommandQueue.Num(); ++CommandIndex)
	{
		const FCheckpointSourceControlCommand& Command = *CommandQueue[CommandIndex];
		if (Command.Operation == InOperation)
		{
			check(Command.bAutoDelete);
			return true;
		}
	}
#endif

  // operation was not in progress!
  return false;
}

void FCheckpointSourceControlProvider::CancelOperation(
  const FSourceControlOperationRef &InOperation
) {
  for (int32 CommandIndex = 0; CommandIndex < CommandQueue.Num();
       ++CommandIndex) {
    FCheckpointSourceControlCommand &Command = *CommandQueue[CommandIndex];
    if (Command.Operation == InOperation) {
      check(Command.bAutoDelete);
      Command.Cancel();
      return;
    }
  }
}

bool FCheckpointSourceControlProvider::UsesLocalReadOnlyState() const {
  return true;
}

bool FCheckpointSourceControlProvider::UsesChangelists() const {
  return true;
}

bool FCheckpointSourceControlProvider::UsesCheckout() const {
  return true;
}

#if StartingInVersion(5, 1)
bool FCheckpointSourceControlProvider::UsesFileRevisions() const {
  return true;
}

TOptional<bool> FCheckpointSourceControlProvider::IsAtLatestRevision() const {
  return TOptional<bool>();
}

TOptional<int> FCheckpointSourceControlProvider::GetNumLocalChanges() const {
  return TOptional<int>();
}
#endif

#if StartingInVersion(5, 2)
bool FCheckpointSourceControlProvider::AllowsDiffAgainstDepot() const {
  return true;
}

bool FCheckpointSourceControlProvider::UsesUncontrolledChangelists() const {
  return true;
}

bool FCheckpointSourceControlProvider::UsesSnapshots() const {
  return false;
}
#endif

#if StartingInVersion(5, 3)
bool FCheckpointSourceControlProvider::CanExecuteOperation(
  const FSourceControlOperationRef &InOperation
) const {
  return WorkersMap.Find(InOperation->GetName()) != nullptr;
}

TMap<ISourceControlProvider::EStatus, FString>
FCheckpointSourceControlProvider::GetStatus() const {
  TMap<EStatus, FString> Result;
  Result.Add(EStatus::Enabled, IsEnabled() ? TEXT("Yes") : TEXT("No"));
  Result.Add(
    EStatus::Connected,
    (IsEnabled() && IsAvailable()) ? TEXT("Yes") : TEXT("No")
  );
  Result.Add(EStatus::Repository, PathToWorkspaceRoot);
  Result.Add(EStatus::Remote, RemoteUrl);
  Result.Add(EStatus::Branch, BranchName);
  return Result;
}
#endif

TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
FCheckpointSourceControlProvider::CreateWorker(
  const FName &InOperationName
) const {
  const FGetCheckpointSourceControlWorker *Operation =
    WorkersMap.Find(InOperationName);
  if (Operation != nullptr) {
    return Operation->Execute();
  }

  return nullptr;
}

void FCheckpointSourceControlProvider::RegisterWorker(
  const FName &InName, const FGetCheckpointSourceControlWorker &InDelegate
) {
  WorkersMap.Add(InName, InDelegate);
}

void FCheckpointSourceControlProvider::OutputCommandMessages(
  const FCheckpointSourceControlCommand &InCommand
) const {
  FTSMessageLog SourceControlLog("SourceControl");

  for (int32 ErrorIndex = 0;
       ErrorIndex < InCommand.ResultInfo.ErrorMessages.Num();
       ++ErrorIndex) {
    SourceControlLog.Error(
      FText::FromString(InCommand.ResultInfo.ErrorMessages[ErrorIndex])
    );
  }

  for (int32 InfoIndex = 0; InfoIndex < InCommand.ResultInfo.InfoMessages.Num();
       ++InfoIndex) {
    SourceControlLog.Info(
      FText::FromString(InCommand.ResultInfo.InfoMessages[InfoIndex])
    );
  }
}

void FCheckpointSourceControlProvider::Tick() {
  bool bStatesUpdated = TicksUntilNextForcedUpdate == 1;
  if (TicksUntilNextForcedUpdate > 0) {
    --TicksUntilNextForcedUpdate;
  }

  for (int32 CommandIndex = 0; CommandIndex < CommandQueue.Num();
       ++CommandIndex) {
    FCheckpointSourceControlCommand &Command = *CommandQueue[CommandIndex];

    if (Command.bExecuteProcessed) {
      // Remove command from the queue
      CommandQueue.RemoveAt(CommandIndex);

      // if (!Command.IsCanceled()) {
      //   // Update repository status on UpdateStatus operations
      //   UpdateRepositoryStatus(Command);
      // }

      // let command update the states of any files
      bStatesUpdated |= Command.Worker->UpdateStates();

      // dump any messages to output log
      OutputCommandMessages(Command);

      // run the completion delegate callback if we have one bound
      if (!Command.IsCanceled()) {
        Command.ReturnResults();
      }

      // commands that are left in the array during a tick need to be deleted
      if (Command.bAutoDelete) {
        // Only delete commands that are not running 'synchronously'
        delete &Command;
      }

      // only do one command per tick loop, as we dont want concurrent modification
      // of the command queue (which can happen in the completion delegate)
      break;
    } else if (Command.bCancelled) {
      // If this was a synchronous command, set it free so that it will be deleted automatically
      // when its (still running) thread finally finishes
      Command.bAutoDelete = true;

      Command.ReturnResults();
      break;
    }
  }

  if (bStatesUpdated) {
    OnSourceControlStateChanged.Broadcast();
  }
}

TArray<TSharedRef<ISourceControlLabel>>
FCheckpointSourceControlProvider::GetLabels(
  const FString &InMatchingSpec
) const {
  TArray<TSharedRef<ISourceControlLabel>> Tags;

  // NOTE list labels. Called by CrashDebugHelper() (to remote debug Engine crash)
  //					 and by SourceControlHelpers::AnnotateFile() (to add source file to report)
  // Reserved for internal use by Epic Games with Perforce only
  return Tags;
}

TArray<FSourceControlChangelistRef>
FCheckpointSourceControlProvider::GetChangelists(
  EStateCacheUsage::Type InStateCacheUsage
) {
  if (!IsEnabled()) {
    return TArray<FSourceControlChangelistRef>();
  }

  TArray<FSourceControlChangelistRef> Changelists;
  Algo::Transform(ChangelistsStateCache, Changelists, [](const auto &Pair) {
    return MakeShared<FCheckpointSourceControlChangelist, ESPMode::ThreadSafe>(
      Pair.Key
    );
  });
  return Changelists;
}

#if SOURCE_CONTROL_WITH_SLATE
TSharedRef<class SWidget> FCheckpointSourceControlProvider::MakeSettingsWidget(
) const {
  return SNew(SCheckpointSourceControlSettings);
}
#endif

ECommandResult::Type
FCheckpointSourceControlProvider::ExecuteSynchronousCommand(
  FCheckpointSourceControlCommand &InCommand,
  const FText &Task,
  bool bSuppressResponseMsg
) {
  ECommandResult::Type Result = ECommandResult::Failed;

  struct Local {
    static void CancelCommand(
      FCheckpointSourceControlCommand *InControlCommand
    ) {
      InControlCommand->Cancel();
    }
  };

  FText TaskText = Task;
  // Display the progress dialog
  if (bSuppressResponseMsg) {
    TaskText = FText::GetEmpty();
  }

  int i = 0;

  // Display the progress dialog if a string was provided
  {
    // TODO: support cancellation?
    //FScopedSourceControlProgress Progress(TaskText, FSimpleDelegate::CreateStatic(&Local::CancelCommand, &InCommand));
    FScopedSourceControlProgress Progress(TaskText);

    // Issue the command asynchronously...
    IssueCommand(InCommand);

    // ... then wait for its completion (thus making it synchronous)
    while (!InCommand.IsCanceled() && CommandQueue.Contains(&InCommand)) {
      // Tick the command queue and update progress.
      Tick();

      if (i >= 20) {
        Progress.Tick();
        i = 0;
      }
      i++;

      // Sleep for a bit so we don't busy-wait so much.
      FPlatformProcess::Sleep(0.01f);
    }

    if (InCommand.bCancelled) {
      Result = ECommandResult::Cancelled;
    }
    if (InCommand.bCommandSuccessful) {
      Result = ECommandResult::Succeeded;
    } else if (!bSuppressResponseMsg) {
      FMessageDialog::Open(
        EAppMsgType::Ok,
        LOCTEXT(
          "Checkpoint_ServerUnresponsive",
          "Checkpoint command failed. Please check your connection and try again, or check the output log for more information."
        )
      );
      UE_LOG(
        LogSourceControl,
        Error,
        TEXT("Command '%s' Failed!"),
        *InCommand.Operation->GetName().ToString()
      );
    }
  }

  // Delete the command now if not marked as auto-delete
  if (!InCommand.bAutoDelete) {
    delete &InCommand;
  }

  return Result;
}

ECommandResult::Type FCheckpointSourceControlProvider::IssueCommand(
  FCheckpointSourceControlCommand &InCommand, const bool bSynchronous
) {
  if (!bSynchronous && GThreadPool != nullptr) {
    // Queue this to our worker thread(s) for resolving.
    // When asynchronous, any callback gets called from Tick().
    GThreadPool->AddQueuedWork(&InCommand);
    CommandQueue.Add(&InCommand);
    return ECommandResult::Succeeded;
  } else {
    UE_LOG(
      LogSourceControl,
      Log,
      TEXT(
        "There are no threads available to process the revision control command '%s'. Running synchronously."
      ),
      *InCommand.Operation->GetName().ToString()
    );

    InCommand.bCommandSuccessful = InCommand.DoWork();

    InCommand.Worker->UpdateStates();

    OutputCommandMessages(InCommand);

    // Callback now if present. When asynchronous, this callback gets called from Tick().
    return InCommand.ReturnResults();
  }
}

bool FCheckpointSourceControlProvider::QueryStateBranchConfig(
  const FString &ConfigSrc, const FString &ConfigDest
) {
  // Check similar preconditions to Perforce (valid src and dest),
  if (ConfigSrc.Len() == 0 || ConfigDest.Len() == 0) {
    return false;
  }

  if (!bInit) {
    FTSMessageLog("SourceControl")
      .Error(LOCTEXT(
        "StatusBranchConfigNoConnection",
        "Unable to retrieve status branch configuration from repo, no connection"
      ));
    return false;
  }

  // Otherwise, we can assume that whatever our user is doing to config state branches is properly synced, so just copy.
  // TODO: maybe don't assume, and use git show instead?
  IFileManager::Get().Copy(*ConfigDest, *ConfigSrc);
  return true;
}

void FCheckpointSourceControlProvider::RegisterStateBranches(
  const TArray<FString> &BranchNames, const FString &ContentRootIn
) {
  StatusBranchNamePatternsInternal = BranchNames;
}

int32 FCheckpointSourceControlProvider::GetStateBranchIndex(
  const FString &StateBranchName
) const {
  // How do state branches indices work?
  // Order matters. Lower values are lower in the hierarchy, i.e., changes from higher branches get automatically merged down.
  // The higher branch is, the stabler it is, and has changes manually promoted up.

  // Check if we are checking the index of the current branch
  // UE uses FEngineVersion for the current branch name because of UEGames setup, but we want to handle otherwise for Git repos.
  auto StatusBranchNames = GetStatusBranchNames();
  if (StateBranchName == FEngineVersion::Current().GetBranch()) {
    const int32 CurrentBranchStatusIndex =
      StatusBranchNames.IndexOfByKey(BranchName);
    const bool bCurrentBranchInStatusBranches =
      CurrentBranchStatusIndex != INDEX_NONE;
    // If the user's current branch is tracked as a status branch, give the proper index
    if (bCurrentBranchInStatusBranches) {
      return CurrentBranchStatusIndex;
    }
    // If the current branch is not a status branch, make it the highest branch
    // This is semantically correct, since if a branch is not marked as a status branch
    // it merges changes in a similar fashion to the highest status branch, i.e. manually promotes them
    // based on the user merging those changes in. and these changes always get merged from even the highest point
    // of the stream. i.e, promoted/stable changes are always up for consumption by this branch.
    return INT32_MAX;
  }

  // If we're not checking the current branch, then we don't need to do special handling.
  // If it is not a status branch, there is no message
  return StatusBranchNames.IndexOfByKey(StateBranchName);
}

TArray<FString> FCheckpointSourceControlProvider::GetStatusBranchNames() const {
  TArray<FString> StatusBranches;

  return StatusBranches;
}

#undef LOCTEXT_NAMESPACE
