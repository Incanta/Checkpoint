#include "CheckpointSourceControlState.h"
#include "RevisionControlStyle/RevisionControlStyle.h"
#include "Textures/SlateIcon.h"

#define LOCTEXT_NAMESPACE "CheckpointSourceControl.State"

PRAGMA_DISABLE_DEPRECATION_WARNINGS
FCheckpointControlState::FCheckpointControlState(
  const FCheckpointControlState &Other
) = default;
FCheckpointControlState::FCheckpointControlState(
  FCheckpointControlState &&Other
) noexcept = default;
FCheckpointControlState &FCheckpointControlState::operator=(
  const FCheckpointControlState &Other
) = default;
FCheckpointControlState &FCheckpointControlState::operator=(
  FCheckpointControlState &&Other
) noexcept = default;
PRAGMA_ENABLE_DEPRECATION_WARNINGS

#if SOURCE_CONTROL_WITH_SLATE

FSlateIcon FGitSourceControlState::GetIcon() const {
  switch (State) {
    case ECheckpointState::ChangedCheckedOut:
    case ECheckpointState::NotChangedCheckedOut:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.CheckedOut"
      );
    case ECheckpointState::Added:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.OpenForAdd"
      );
    case ECheckpointState::Renamed:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.Branched"
      );
    case ECheckpointState::Deleted:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.MarkedForDelete"
      );
    case ECheckpointState::Conflicted:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.Conflicted"
      );
    case ECheckpointState::Local:
    // ChangedNotCheckedOut should prompt the user to figure out
    // what to do; this shows up as a ? icon
    case ECheckpointState::ChangedNotCheckedOut:
      return FSlateIcon(
        FRevisionControlStyleManager::GetStyleSetName(),
        "RevisionControl.NotInDepot"
      );
    case ECheckpointState::Unknown:
    case ECheckpointState::ReadOnlyControlled:
    case ECheckpointState::WritableControlled:
    case ECheckpointState::Ignored:
    case ECheckpointState::Cloaked:
    case ECheckpointState::Artifact:
    default:
      return FSlateIcon();
  }
}

#endif //SOURCE_CONTROL_WITH_SLATE

FText FGitSourceControlState::GetDisplayName() const {
  switch (WorkingCopyState) {
    case EWorkingCopyState::Unknown:
      return LOCTEXT("Unknown", "Unknown");
    case EWorkingCopyState::Unchanged:
      return LOCTEXT("Unchanged", "Unchanged");
    case EWorkingCopyState::Added:
      return LOCTEXT("Added", "Added");
    case EWorkingCopyState::Deleted:
      return LOCTEXT("Deleted", "Deleted");
    case EWorkingCopyState::Modified:
      return LOCTEXT("Modified", "Modified");
    case EWorkingCopyState::Renamed:
      return LOCTEXT("Renamed", "Renamed");
    case EWorkingCopyState::Copied:
      return LOCTEXT("Copied", "Copied");
    case EWorkingCopyState::Conflicted:
      return LOCTEXT("ContentsConflict", "Contents Conflict");
    case EWorkingCopyState::Ignored:
      return LOCTEXT("Ignored", "Ignored");
    case EWorkingCopyState::NotControlled:
      return LOCTEXT("NotControlled", "Not Under Revision Control");
    case EWorkingCopyState::Missing:
      return LOCTEXT("Missing", "Missing");
  }

  return FText();
}

FText FGitSourceControlState::GetDisplayTooltip() const {
  switch (WorkingCopyState) {
    case EWorkingCopyState::Unknown:
      return LOCTEXT("Unknown_Tooltip", "Unknown revision control state");
    case EWorkingCopyState::Unchanged:
      return LOCTEXT("Pristine_Tooltip", "There are no modifications");
    case EWorkingCopyState::Added:
      return LOCTEXT("Added_Tooltip", "Item is scheduled for addition");
    case EWorkingCopyState::Deleted:
      return LOCTEXT("Deleted_Tooltip", "Item is scheduled for deletion");
    case EWorkingCopyState::Modified:
      return LOCTEXT("Modified_Tooltip", "Item has been modified");
    case EWorkingCopyState::Renamed:
      return LOCTEXT("Renamed_Tooltip", "Item has been renamed");
    case EWorkingCopyState::Copied:
      return LOCTEXT("Copied_Tooltip", "Item has been copied");
    case EWorkingCopyState::Conflicted:
      return LOCTEXT(
        "ContentsConflict_Tooltip",
        "The contents of the item conflict with updates received from the repository."
      );
    case EWorkingCopyState::Ignored:
      return LOCTEXT("Ignored_Tooltip", "Item is being ignored.");
    case EWorkingCopyState::NotControlled:
      return LOCTEXT(
        "NotControlled_Tooltip", "Item is not under version control."
      );
    case EWorkingCopyState::Missing:
      return LOCTEXT(
        "Missing_Tooltip",
        "Item is missing (e.g., you moved or deleted it without using Git). This also indicates that a directory is incomplete (a checkout or update was interrupted)."
      );
  }

  return FText();
}

const FString &FGitSourceControlState::GetFilename() const {
  return Filename;
}
