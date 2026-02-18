// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ISourceControlProvider.h"

#include "CheckpointDaemonClient.h"
#include "CheckpointSourceControlChangelistState.h"
#include "CheckpointSourceControlSettings.h"
#include "CheckpointSourceControlState.h"

class FCheckpointSourceControlCommand;
class ICheckpointSourceControlWorker;

/**
 * Checkpoint source control provider implementation.
 * Communicates with the Checkpoint daemon for all operations.
 */
class FCheckpointSourceControlProvider : public ISourceControlProvider {
public:
  FCheckpointSourceControlProvider();
  virtual ~FCheckpointSourceControlProvider() = default;

  // ISourceControlProvider
  virtual void Init(bool bForceConnection = true) override;
  virtual void Close() override;
  virtual const FName &GetName() const override;
  virtual FText GetStatusText() const override;
  virtual TMap<EStatus, FString> GetStatus() const override;
  virtual bool IsEnabled() const override;
  virtual bool IsAvailable() const override;

  virtual bool QueryStateBranchConfig(
    const FString &ConfigSrc, const FString &ConfigDest
  ) override;

  virtual void RegisterStateBranches(
    const TArray<FString> &BranchNames, const FString &ContentRoot
  ) override;

  virtual int32 GetStateBranchIndex(const FString &BranchName) const override;

  virtual bool GetStateBranchAtIndex(
    int32 BranchIndex, FString &OutBranchName
  ) const override;

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
    EConcurrency::Type InConcurrency,
    const FSourceControlOperationComplete &InOperationCompleteDelegate
  ) override;

  virtual bool CanExecuteOperation(
    const FSourceControlOperationRef &InOperation
  ) const override;

  virtual bool CanCancelOperation(
    const FSourceControlOperationRef &InOperation
  ) const override;

  virtual void CancelOperation(
    const FSourceControlOperationRef &InOperation
  ) override;

  virtual TArray<TSharedRef<class ISourceControlLabel>> GetLabels(
    const FString &InMatchingSpec
  ) const override;

  virtual TArray<FSourceControlChangelistRef> GetChangelists(
    EStateCacheUsage::Type InStateCacheUsage
  ) override;

  virtual bool UsesLocalReadOnlyState() const override;
  virtual bool UsesChangelists() const override;
  virtual bool UsesUncontrolledChangelists() const override;
  virtual bool UsesCheckout() const override;
  virtual bool UsesFileRevisions() const override;
  virtual bool UsesSnapshots() const override;
  virtual bool AllowsDiffAgainstDepot() const override;
  virtual TOptional<bool> IsAtLatestRevision() const override;
  virtual TOptional<int> GetNumLocalChanges() const override;
  virtual void Tick() override;

#if SOURCE_CONTROL_WITH_SLATE
  virtual TSharedRef<class SWidget> MakeSettingsWidget() const override;
#endif

  // Internal accessors

  /** Get a reference to the state for a file, creating if needed */
  TSharedRef<FCheckpointSourceControlState, ESPMode::ThreadSafe>
  GetStateInternal(const FString &InFilename);

  /** Get a reference to the changelist state, creating if needed */
  TSharedRef<FCheckpointSourceControlChangelistState, ESPMode::ThreadSafe>
  GetChangelistStateInternal(
    const FCheckpointSourceControlChangelist &InChangelist
  );

  /** Access the daemon client */
  FCheckpointDaemonClient &GetDaemonClient() {
    return DaemonClient;
  }

  /** Access settings */
  FCheckpointSourceControlSettings &AccessSettings() {
    return Settings;
  }

  const FCheckpointSourceControlSettings &AccessSettings() const {
    return Settings;
  }

  /** Convert absolute path to workspace-relative path */
  FString ToRelativePath(const FString &AbsolutePath) const;

  /** Convert workspace-relative path to absolute path */
  FString ToAbsolutePath(const FString &RelPath) const;

  /** Whether the daemon is reachable */
  bool IsDaemonAvailable() const {
    return bServerAvailable;
  }

  /** Fire the state changed delegate */
  void BroadcastStateChanged() {
    OnSourceControlStateChanged.Broadcast();
  }

  /** Get the current user's email */
  const FString &GetUserEmail() const {
    return UserEmail;
  }

  /** Get the workspace name */
  const FString &GetWorkspaceName() const {
    return WorkspaceName;
  }

private:
  /** Create a worker for the given operation */
  TSharedPtr<ICheckpointSourceControlWorker, ESPMode::ThreadSafe> CreateWorker(
    const FName &InOperationName
  ) const;

  /** Execute a command synchronously */
  ECommandResult::Type ExecuteSynchronousCommand(
    FCheckpointSourceControlCommand &InCommand, const FText &InTask
  );

  /** Issue a command (sync or async) */
  ECommandResult::Type IssueCommand(FCheckpointSourceControlCommand &InCommand);

private:
  FCheckpointSourceControlSettings Settings;
  FCheckpointDaemonClient DaemonClient;

  bool bServerAvailable;
  FString UserEmail;
  FString UserName;
  FString WorkspaceName;

  /** State cache: maps absolute file path -> state */
  TMap<FString, TSharedRef<FCheckpointSourceControlState, ESPMode::ThreadSafe>>
    StateCache;

  /** Changelist state cache: maps changelist -> state */
  TMap<
    FCheckpointSourceControlChangelist,
    TSharedRef<FCheckpointSourceControlChangelistState, ESPMode::ThreadSafe>>
    ChangelistsStateCache;

  /** Queue of async commands */
  TArray<FCheckpointSourceControlCommand *> CommandQueue;

  /** Delegate for state change notifications */
  FSourceControlStateChanged OnSourceControlStateChanged;
};
