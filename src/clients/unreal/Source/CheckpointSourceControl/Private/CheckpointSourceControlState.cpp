// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointSourceControlState.h"

#include "CheckpointSourceControlModule.h"

#if SOURCE_CONTROL_WITH_SLATE
  #include "RevisionControlStyle/RevisionControlStyle.h"
  #include "Textures/SlateIcon.h"
#endif //SOURCE_CONTROL_WITH_SLATE

TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
FCheckpointSourceControlState::GetHistoryItem(int32 HistoryIndex) const {
  if (History.IsValidIndex(HistoryIndex)) {
    return History[HistoryIndex];
  }
  return nullptr;
}

TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
FCheckpointSourceControlState::FindHistoryRevision(int32 RevisionNumber) const {
  for (const auto &Rev : History) {
    if (Rev->GetRevisionNumber() == RevisionNumber) {
      return Rev;
    }
  }
  return nullptr;
}

TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
FCheckpointSourceControlState::FindHistoryRevision(
  const FString &InRevision
) const {
  for (const auto &Rev : History) {
    if (Rev->GetRevision() == InRevision) {
      return Rev;
    }
  }
  return nullptr;
}

TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
FCheckpointSourceControlState::GetCurrentRevision() const {
  if (History.Num() > 0) {
    return History[0];
  }
  return nullptr;
}

#if SOURCE_CONTROL_WITH_SLATE
FSlateIcon FCheckpointSourceControlState::GetIcon() const {
  switch (FileStatus) {
    case ECheckpointFileStatus::Added:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.OpenForAdd"
      );
    case ECheckpointFileStatus::Deleted:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.MarkedForDelete"
      );
    case ECheckpointFileStatus::ChangedCheckedOut:
    case ECheckpointFileStatus::NotChangedCheckedOut:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.CheckedOut"
      );
    case ECheckpointFileStatus::Renamed:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.Branched"
      );
    case ECheckpointFileStatus::Conflicted:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.Conflicted"
      );
    case ECheckpointFileStatus::ReadOnlyControlled:
    case ECheckpointFileStatus::WritableControlled:
    case ECheckpointFileStatus::HiddenChanges:
    case ECheckpointFileStatus::Artifact:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.CheckedIn"
      );
    case ECheckpointFileStatus::ChangedNotCheckedOut:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.NotAtHeadRevision"
      );
    case ECheckpointFileStatus::Local:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.NotInDepot"
      );
    default:
      return FSlateIcon();
  }
}
#endif

FText FCheckpointSourceControlState::GetDisplayName() const {
  switch (FileStatus) {
    case ECheckpointFileStatus::Added:
      return NSLOCTEXT("CheckpointSC", "Added", "Added");
    case ECheckpointFileStatus::Deleted:
      return NSLOCTEXT("CheckpointSC", "Deleted", "Deleted");
    case ECheckpointFileStatus::ChangedCheckedOut:
      return NSLOCTEXT(
        "CheckpointSC", "CheckedOutModified", "Checked Out (Modified)"
      );
    case ECheckpointFileStatus::NotChangedCheckedOut:
      return NSLOCTEXT("CheckpointSC", "CheckedOut", "Checked Out");
    case ECheckpointFileStatus::Renamed:
      return NSLOCTEXT("CheckpointSC", "Renamed", "Renamed");
    case ECheckpointFileStatus::Conflicted:
      return NSLOCTEXT("CheckpointSC", "Conflicted", "Conflicted");
    case ECheckpointFileStatus::ReadOnlyControlled:
      return NSLOCTEXT("CheckpointSC", "Controlled", "Controlled");
    case ECheckpointFileStatus::WritableControlled:
      return NSLOCTEXT("CheckpointSC", "Controlled", "Controlled");
    case ECheckpointFileStatus::ChangedNotCheckedOut:
      return NSLOCTEXT(
        "CheckpointSC", "ModifiedNotCheckedOut", "Modified (Not Checked Out)"
      );
    case ECheckpointFileStatus::Local:
      return NSLOCTEXT(
        "CheckpointSC", "NotControlled", "Not Under Source Control"
      );
    case ECheckpointFileStatus::Ignored:
      return NSLOCTEXT("CheckpointSC", "Ignored", "Ignored");
    default:
      return NSLOCTEXT("CheckpointSC", "Unknown", "Unknown");
  }
}

FText FCheckpointSourceControlState::GetDisplayTooltip() const {
  switch (FileStatus) {
    case ECheckpointFileStatus::Added:
      return NSLOCTEXT(
        "CheckpointSC",
        "AddedTooltip",
        "File is marked for addition to source control"
      );
    case ECheckpointFileStatus::Deleted:
      return NSLOCTEXT(
        "CheckpointSC",
        "DeletedTooltip",
        "File is marked for deletion from source control"
      );
    case ECheckpointFileStatus::ChangedCheckedOut:
      return NSLOCTEXT(
        "CheckpointSC",
        "CheckedOutModifiedTooltip",
        "File is checked out and has been modified"
      );
    case ECheckpointFileStatus::NotChangedCheckedOut:
      return NSLOCTEXT(
        "CheckpointSC",
        "CheckedOutTooltip",
        "File is checked out but not yet modified"
      );
    case ECheckpointFileStatus::Conflicted:
      return NSLOCTEXT(
        "CheckpointSC",
        "ConflictedTooltip",
        "File has conflicts that need resolution"
      );
    case ECheckpointFileStatus::ReadOnlyControlled:
    case ECheckpointFileStatus::WritableControlled:
      return NSLOCTEXT(
        "CheckpointSC",
        "ControlledTooltip",
        "File is under source control and up to date"
      );
    case ECheckpointFileStatus::ChangedNotCheckedOut:
      return NSLOCTEXT(
        "CheckpointSC",
        "ModifiedNotCheckedOutTooltip",
        "File has been modified but is not checked out"
      );
    case ECheckpointFileStatus::Local:
      return NSLOCTEXT(
        "CheckpointSC",
        "NotControlledTooltip",
        "File is not under source control"
      );
    default:
      return FText::GetEmpty();
  }
}

bool FCheckpointSourceControlState::CanCheckIn() const {
  return FileStatus == ECheckpointFileStatus::Local ||
    FileStatus == ECheckpointFileStatus::Added ||
    FileStatus == ECheckpointFileStatus::Renamed ||
    FileStatus == ECheckpointFileStatus::Deleted ||
    FileStatus == ECheckpointFileStatus::ChangedNotCheckedOut ||
    FileStatus == ECheckpointFileStatus::ChangedCheckedOut;
}

bool FCheckpointSourceControlState::CanCheckout() const {
  return FileStatus == ECheckpointFileStatus::ReadOnlyControlled ||
    FileStatus == ECheckpointFileStatus::WritableControlled ||
    FileStatus == ECheckpointFileStatus::ChangedNotCheckedOut;
}

bool FCheckpointSourceControlState::IsCheckedOut() const {
  return FileStatus == ECheckpointFileStatus::ChangedCheckedOut ||
    FileStatus == ECheckpointFileStatus::NotChangedCheckedOut;
}

bool FCheckpointSourceControlState::IsCheckedOutOther(FString *Who) const {
  if (!OtherUserCheckedOut.IsEmpty()) {
    if (Who) {
      *Who = OtherUserCheckedOut;
    }
    return true;
  }
  return false;
}

bool FCheckpointSourceControlState::IsCheckedOutInOtherBranch(
  const FString &CurrentBranch
) const {
  return false;
}

bool FCheckpointSourceControlState::IsModifiedInOtherBranch(
  const FString &CurrentBranch
) const {
  return false;
}

bool FCheckpointSourceControlState::IsCheckedOutOrModifiedInOtherBranch(
  const FString &CurrentBranch
) const {
  return false;
}

TArray<FString> FCheckpointSourceControlState::GetCheckedOutBranches() const {
  return TArray<FString>();
}

FString FCheckpointSourceControlState::GetOtherUserBranchCheckedOuts() const {
  return FString();
}

bool FCheckpointSourceControlState::GetOtherBranchHeadModification(
  FString &HeadBranchOut, FString &ActionOut, int32 &HeadChangeListOut
) const {
  return false;
}

bool FCheckpointSourceControlState::IsCurrent() const {
  // TODO MIKE HERE: the daemon needs to keep track if the local file is at the latest revision or not,
  // and this method should return that value. For now we will just return true to avoid showing
  // "not at head" status for all files.
  return FileStatus == ECheckpointFileStatus::Added ||
    FileStatus == ECheckpointFileStatus::ReadOnlyControlled ||
    FileStatus == ECheckpointFileStatus::WritableControlled ||
    FileStatus == ECheckpointFileStatus::NotChangedCheckedOut ||
    FileStatus == ECheckpointFileStatus::ChangedCheckedOut ||
    FileStatus == ECheckpointFileStatus::HiddenChanges ||
    FileStatus == ECheckpointFileStatus::Artifact;
}

bool FCheckpointSourceControlState::IsSourceControlled() const {
  switch (FileStatus) {
    case ECheckpointFileStatus::Unknown:
    case ECheckpointFileStatus::Local:
    case ECheckpointFileStatus::Ignored:
    case ECheckpointFileStatus::Artifact:
      return false;
    default:
      return true;
  }
}

bool FCheckpointSourceControlState::IsAdded() const {
  return FileStatus == ECheckpointFileStatus::Added;
}

bool FCheckpointSourceControlState::IsDeleted() const {
  return FileStatus == ECheckpointFileStatus::Deleted;
}

bool FCheckpointSourceControlState::IsIgnored() const {
  return FileStatus == ECheckpointFileStatus::Ignored;
}

bool FCheckpointSourceControlState::CanEdit() const {
  return IsCheckedOut() ||
    FileStatus == ECheckpointFileStatus::WritableControlled ||
    FileStatus == ECheckpointFileStatus::ChangedNotCheckedOut ||
    FileStatus == ECheckpointFileStatus::Added ||
    FileStatus == ECheckpointFileStatus::Local;
}

bool FCheckpointSourceControlState::CanDelete() const {
  return IsSourceControlled() && !IsCheckedOutOther();
}

bool FCheckpointSourceControlState::IsUnknown() const {
  return FileStatus == ECheckpointFileStatus::Unknown ||
    FileStatus == ECheckpointFileStatus::NotInWorkspaceRoot;
}

bool FCheckpointSourceControlState::IsModified() const {
  return FileStatus == ECheckpointFileStatus::ChangedCheckedOut ||
    FileStatus == ECheckpointFileStatus::ChangedNotCheckedOut ||
    FileStatus == ECheckpointFileStatus::Added ||
    FileStatus == ECheckpointFileStatus::Deleted ||
    FileStatus == ECheckpointFileStatus::Renamed;
}

bool FCheckpointSourceControlState::CanAdd() const {
  return FileStatus == ECheckpointFileStatus::Local;
}

bool FCheckpointSourceControlState::CanRevert() const {
  return IsModified() || IsCheckedOut();
}
