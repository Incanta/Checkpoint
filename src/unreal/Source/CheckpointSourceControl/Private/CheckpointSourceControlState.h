#pragma once

#include "CoreMinimal.h"
#include "ISourceControlState.h"

namespace ECheckpointState {
  enum Type {
    Unknown,
    NotInWorkspaceRoot,
    Local,
    Added,
    Renamed,
    Deleted,
    Ignored,
    Cloaked,
    ReadOnlyControlled,
    WritableControlled,
    ChangedNotCheckedOut,
    ChangedCheckedOut,
    NotChangedCheckedOut,
    Conflicted,
    Artifact,
  }
}

class FCheckpointSourceControlState : public ISourceControlState {
public:
  FCheckpointSourceControlState(
    const FString &InFilename,
    ECheckpointState::Type InState = ECheckpointState::Unknown
  ) : Filename(InFilename), OldFilename(InFilename), State(InState) {
    // Constructor implementation
  }

  FCheckpointSourceControlState(const FCheckpointSourceControlState &Other);
  FCheckpointSourceControlState(FCheckpointSourceControlState &&Other) noexcept;
  FCheckpointSourceControlState &operator=(
    const FCheckpointSourceControlState &Other
  );
  FCheckpointSourceControlState &operator=(FCheckpointSourceControlState &&Other
  ) noexcept;

  /** ISourceControlState interface */
#if SOURCE_CONTROL_WITH_SLATE
  virtual FSlateIcon GetIcon() const override;
#endif //SOURCE_CONTROL_WITH_SLATE
  virtual FText GetDisplayName() const override;
  virtual FText GetDisplayTooltip() const override;
  virtual const FString &GetFilename() const override;
  // virtual const FDateTime& GetTimeStamp() const override;

  virtual bool CanCheckIn() const override;
  virtual bool CanCheckout() const override;
  virtual bool IsCheckedOut() const override;
  virtual bool IsCheckedOutOther(FString *Who = nullptr) const override;
  virtual bool IsCheckedOutInOtherBranch(
    const FString &CurrentBranch = FString()
  ) const override {
    return false;
  }
  virtual bool IsModifiedInOtherBranch(
    const FString &CurrentBranch = FString()
  ) const override {
    return false;
  }
  virtual bool IsCheckedOutOrModifiedInOtherBranch(
    const FString &CurrentBranch = FString()
  ) const override {
    return IsCheckedOutInOtherBranch(CurrentBranch) ||
      IsModifiedInOtherBranch(CurrentBranch);
  }
  virtual TArray<FString> GetCheckedOutBranches() const override {
    return TArray<FString>();
  }
  virtual FString GetOtherUserBranchCheckedOuts() const override {
    return FString();
  }
  virtual bool GetOtherBranchHeadModification(
    FString &HeadBranchOut, FString &ActionOut, int32 &HeadChangeListOut
  ) const override {
    return false;
  }
  virtual bool IsCurrent() const override;
  virtual bool IsSourceControlled() const override;
  virtual bool IsAdded() const override;
  virtual bool IsDeleted() const override;
  virtual bool IsIgnored() const override;
  virtual bool CanEdit() const override;
  virtual bool IsUnknown() const override;
  virtual bool IsModified() const override;
  virtual bool CanAdd() const override;
  virtual bool CanDelete() const override;
  virtual bool IsConflicted() const override;
  virtual bool CanRevert() const override;

public:
  FString Filename;
  FString OldFilename; // Different from Filename if the file was renamed

  ECheckpointState::Type State;
};
