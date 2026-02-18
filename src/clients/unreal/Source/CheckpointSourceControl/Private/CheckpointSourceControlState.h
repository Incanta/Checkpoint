// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ISourceControlState.h"

#include "CheckpointSourceControlChangelist.h"
#include "CheckpointSourceControlRevision.h"

/**
 * Maps Checkpoint's FileStatus enum to meaningful values.
 */
namespace ECheckpointFileStatus {
  enum Type {
    Unknown = 0,
    NotInWorkspaceRoot = 1,
    Local = 2,
    Added = 3,
    Renamed = 4,
    Deleted = 5,
    Ignored = 6,
    HiddenChanges = 7,
    ReadOnlyControlled = 8,
    WritableControlled = 9,
    ChangedNotCheckedOut = 10,
    ChangedCheckedOut = 11,
    NotChangedCheckedOut = 12,
    Conflicted = 13,
    Artifact = 14,
  };
}

/**
 * Source control state for a single file tracked by Checkpoint.
 */
class FCheckpointSourceControlState
  : public ISourceControlState {
public:
  FCheckpointSourceControlState(const FString& InLocalFilename)
    : LocalFilename(InLocalFilename),
      FileStatus(ECheckpointFileStatus::Unknown),
      TimeStamp(FDateTime::Now()) {}

  FCheckpointSourceControlState(
    const FString& InLocalFilename,
    ECheckpointFileStatus::Type InStatus
  ) : LocalFilename(InLocalFilename),
      FileStatus(InStatus),
      TimeStamp(FDateTime::Now()) {}

  // ISourceControlState
  virtual int32 GetHistorySize() const override {
    return History.Num();
  }

  virtual TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
  GetHistoryItem(int32 HistoryIndex) const override;

  virtual TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
  FindHistoryRevision(int32 RevisionNumber) const override;

  virtual TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
  FindHistoryRevision(const FString& InRevision) const override;

  virtual TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
  GetCurrentRevision() const override;

#if SOURCE_CONTROL_WITH_SLATE
  virtual FSlateIcon GetIcon() const override;
#endif

  virtual FText GetDisplayName() const override;
  virtual FText GetDisplayTooltip() const override;

  virtual const FString& GetFilename() const override {
    return LocalFilename;
  }

  virtual const FDateTime& GetTimeStamp() const override {
    return TimeStamp;
  }

  virtual bool CanCheckIn() const override;
  virtual bool CanCheckout() const override;
  virtual bool IsCheckedOut() const override;
  virtual bool IsCheckedOutOther(
    FString* Who = nullptr
  ) const override;
  virtual bool IsCheckedOutInOtherBranch(
    const FString& CurrentBranch = FString()
  ) const override;
  virtual bool IsModifiedInOtherBranch(
    const FString& CurrentBranch = FString()
  ) const override;
  virtual bool IsCheckedOutOrModifiedInOtherBranch(
    const FString& CurrentBranch = FString()
  ) const override;
  virtual TArray<FString>
  GetCheckedOutBranches() const override;
  virtual FString
  GetOtherUserBranchCheckedOuts() const override;
  virtual bool GetOtherBranchHeadModification(
    FString& HeadBranchOut,
    FString& ActionOut,
    int32& HeadChangeListOut
  ) const override;
  virtual bool IsCurrent() const override;
  virtual bool IsSourceControlled() const override;
  virtual bool IsAdded() const override;
  virtual bool IsDeleted() const override;
  virtual bool IsIgnored() const override;
  virtual bool CanEdit() const override;
  virtual bool CanDelete() const override;
  virtual bool IsUnknown() const override;
  virtual bool IsModified() const override;
  virtual bool CanAdd() const override;
  virtual bool CanRevert() const override;

public:
  /** Set the file status from a Checkpoint FileStatus int */
  void SetFileStatus(int32 InStatus) {
    FileStatus =
      static_cast<ECheckpointFileStatus::Type>(InStatus);
  }

  void SetFileStatus(ECheckpointFileStatus::Type InStatus) {
    FileStatus = InStatus;
  }

  ECheckpointFileStatus::Type GetFileStatus() const {
    return FileStatus;
  }

  /** The absolute local path of this file */
  FString LocalFilename;

  /** The Checkpoint file status */
  ECheckpointFileStatus::Type FileStatus;

  /** Revision history */
  TArray<TSharedRef<
    FCheckpointSourceControlRevision,
    ESPMode::ThreadSafe
  >> History;

  /** Who else has this file checked out */
  FString OtherUserCheckedOut;

  /** Whether the file is exclusively locked */
  bool bIsLocked = false;

  /** The changelist number this file was last synced to */
  int32 ChangelistNumber = -1;

  /** Timestamp for the state */
  FDateTime TimeStamp;
};
