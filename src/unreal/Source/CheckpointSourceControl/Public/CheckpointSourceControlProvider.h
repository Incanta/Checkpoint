// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#pragma once

#include "CheckpointMacros.h"

#include "CheckpointSourceControlChangelist.h"
#include "ICheckpointSourceControlWorker.h"
#include "ISourceControlProvider.h"
#include "Runtime/Launch/Resources/Version.h"

class FCheckpointSourceControlChangelistState;
class FCheckpointSourceControlState;

class FCheckpointSourceControlCommand;

DECLARE_DELEGATE_RetVal(
  FCheckpointSourceControlWorkerRef, FGetCheckpointSourceControlWorker
);

class CHECKPOINTSOURCECONTROL_API FCheckpointSourceControlProvider final
  : public ISourceControlProvider {
public:
  /* ISourceControlProvider implementation */
  virtual void Init(bool bForceConnection = true) override;
  virtual void Close() override;
  virtual FText GetStatusText() const override;
  virtual bool IsEnabled() const override;
  virtual bool IsAvailable() const override;
  virtual const FName &GetName(void) const override;
  virtual bool QueryStateBranchConfig(
    const FString &ConfigSrc, const FString &ConfigDest
  ) override;
  virtual void RegisterStateBranches(
    const TArray<FString> &BranchNames, const FString &ContentRootIn
  ) override;
  virtual int32 GetStateBranchIndex(const FString &BranchName) const override;
  virtual ECommandResult::Type GetState(
    const TArray<FString> &InFiles,
    TArray<FSourceControlStateRef> &OutState,
    EStateCacheUsage::Type InStateCacheUsage
  ) override;
  virtual ECommandResult::Type GetState(
    const TArray<FSourceControlChangelistRef> &InChangelists,
    TArray<FSourceControlChangelistStateRef> &OutState,
    EStateCacheUsage::Type InStateCacheUsage
  ) override;
  virtual TArray<FSourceControlStateRef> GetCachedStateByPredicate(
    TFunctionRef<bool(const FSourceControlStateRef &)> Predicate
  ) const override;
  virtual FDelegateHandle RegisterSourceControlStateChanged_Handle(
    const FSourceControlStateChanged::FDelegate &SourceControlStateChanged
  ) override;
  virtual void UnregisterSourceControlStateChanged_Handle(
    FDelegateHandle Handle
  ) override;
  virtual ECommandResult::Type Execute(
    const FSourceControlOperationRef &InOperation,
    FSourceControlChangelistPtr InChangelist,
    const TArray<FString> &InFiles,
    EConcurrency::Type InConcurrency = EConcurrency::Synchronous,
    const FSourceControlOperationComplete &InOperationCompleteDelegate =
      FSourceControlOperationComplete()
  ) override;
  virtual bool CanCancelOperation(
    const FSourceControlOperationRef &InOperation
  ) const override;
  virtual void CancelOperation(
    const FSourceControlOperationRef &InOperation
  ) override;
  virtual bool UsesLocalReadOnlyState() const override;
  virtual bool UsesChangelists() const override;
  virtual bool UsesCheckout() const override;
#if StartingInVersion(5, 1)
  virtual bool UsesFileRevisions() const override;
  virtual TOptional<bool> IsAtLatestRevision() const override;
  virtual TOptional<int> GetNumLocalChanges() const override;
#endif
#if StartingInVersion(5, 2)
  virtual bool AllowsDiffAgainstDepot() const override;
  virtual bool UsesUncontrolledChangelists() const override;
  virtual bool UsesSnapshots() const override;
#endif
#if StartingInVersion(5, 3)
  virtual bool CanExecuteOperation(
    const FSourceControlOperationRef &InOperation
  ) const override;
  virtual TMap<EStatus, FString> GetStatus() const override;
#endif
  virtual void Tick() override;
  virtual TArray<TSharedRef<class ISourceControlLabel>> GetLabels(
    const FString &InMatchingSpec
  ) const override;

  virtual TArray<FSourceControlChangelistRef> GetChangelists(
    EStateCacheUsage::Type InStateCacheUsage
  ) override;

#if SOURCE_CONTROL_WITH_SLATE
  virtual TSharedRef<class SWidget> MakeSettingsWidget() const override;
#endif

  using ISourceControlProvider::Execute;;

  /** Path to the root of the Unreal revision control repository: usually the ProjectDir */
  inline const FString &GetPathToWorkspaceRoot() const {
    return PathToWorkspaceRoot;
  }

  /**
   * Register a worker with the provider.
   * This is used internally so the provider can maintain a map of all available operations.
   */
  void RegisterWorker(
    const FName &InName, const FGetCheckpointSourceControlWorker &InDelegate
  );

  /** Set list of error messages that occurred after last perforce command */
  void SetLastErrors(const TArray<FText> &InErrors);

  /** Get list of error messages that occurred after last perforce command */
  TArray<FText> GetLastErrors() const;

  /** Get number of error messages seen after running last perforce command */
  int32 GetNumLastErrors() const;

  /** Remove a named file from the state cache */
  bool RemoveFileFromCache(const FString &Filename);

  /** Get files in cache */
  TArray<FString> GetFilesInCache();

  bool AddFileToIgnoreForceCache(const FString &Filename);

  bool RemoveFileFromIgnoreForceCache(const FString &Filename);

  TArray<FString> GetStatusBranchNames() const;

  /** Indicates editor binaries are to be updated upon next sync */
  bool bPendingRestart;

  uint32 TicksUntilNextForcedUpdate = 0;

private:
  bool bInit = false;

  /** Critical section for thread safety of error messages that occurred after last perforce command */
  mutable FCriticalSection LastErrorsCriticalSection;

  /** List of error messages that occurred after last perforce command */
  TArray<FText> LastErrors;

  /** Helper function for Execute() */
  TSharedPtr<class ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
  CreateWorker(const FName &InOperationName) const;

  /** Helper function for running command synchronously. */
  ECommandResult::Type ExecuteSynchronousCommand(
    class FCheckpointSourceControlCommand &InCommand,
    const FText &Task,
    bool bSuppressResponseMsg
  );
  /** Issue a command asynchronously if possible. */
  ECommandResult::Type IssueCommand(
    class FCheckpointSourceControlCommand &InCommand,
    const bool bSynchronous = false
  );

  /** Output any messages this command holds */
  void OutputCommandMessages(
    const class FCheckpointSourceControlCommand &InCommand
  ) const;

  /** Path to the root of the Checkpoint workspace */
  FString PathToWorkspaceRoot;

  /** Name of the current branch */
  FString BranchName;

  /** Name of the current remote branch */
  FString RemoteBranchName;

  /** URL of the "origin" default remote server */
  FString RemoteUrl;

  /** State cache */
  TMap<
    FString,
    TSharedRef<class FCheckpointSourceControlState, ESPMode::ThreadSafe>>
    StateCache;
  TMap<
    FCheckpointSourceControlChangelist,
    TSharedRef<
      class FCheckpointSourceControlChangelistState,
      ESPMode::ThreadSafe>>
    ChangelistsStateCache;

  /** The currently registered revision control operations */
  TMap<FName, FGetCheckpointSourceControlWorker> WorkersMap;

  /** Queue for commands given by the main thread */
  TArray<FCheckpointSourceControlCommand *> CommandQueue;

  /** For notifying when the revision control states in the cache have changed */
  FSourceControlStateChanged OnSourceControlStateChanged;

  /**
   * Ignore these files when forcing status updates. We add to this list when we've just updated the status already.
   * UE's SourceControl has a habit of performing a double status update, immediately after an operation.
   */
  TArray<FString> IgnoreForceCache;

  /** Array of branch name patterns for status queries */
  TArray<FString> StatusBranchNamePatternsInternal;

  class FCheckpointSourceControlRunner *Runner = nullptr;
};
