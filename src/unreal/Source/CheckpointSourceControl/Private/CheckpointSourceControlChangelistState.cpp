#include "CheckpointSourceControlChangelistState.h"
#include "CheckpointMacros.h"

#define LOCTEXT_NAMESPACE "CheckpointSourceControl.ChangelistState"

FName FCheckpointSourceControlChangelistState::GetIconName() const {
  // Mimic P4V colors, returning the red icon if there are active file(s), the blue if the changelist is empty or all the files are shelved.
  return FName("SourceControl.Changelist");
}

FName FCheckpointSourceControlChangelistState::GetSmallIconName() const {
  return GetIconName();
}

FText FCheckpointSourceControlChangelistState::GetDisplayText() const {
  return FText::FromString(Changelist.GetName());
}

FText FCheckpointSourceControlChangelistState::GetDescriptionText() const {
  return FText::FromString(Description);
}

FText FCheckpointSourceControlChangelistState::GetDisplayTooltip() const {
  return LOCTEXT("Tooltip", "Tooltip");
}

const FDateTime &FCheckpointSourceControlChangelistState::GetTimeStamp() const {
  return TimeStamp;
}

#if StartingInVersion(5, 4)
const TArray<FSourceControlStateRef>
FCheckpointSourceControlChangelistState::GetFilesStates() const
#else
const TArray<FSourceControlStateRef> &
FCheckpointSourceControlChangelistState::GetFilesStates() const
#endif
{
  return Files;
}

#if StartingInVersion(5, 4)
int32 FCheckpointSourceControlChangelistState::GetFilesStatesNum() const {
  return Files.Num();
}
#endif

#if StartingInVersion(5, 4)
const TArray<FSourceControlStateRef>
FCheckpointSourceControlChangelistState::GetShelvedFilesStates() const
#else
const TArray<FSourceControlStateRef> &
FCheckpointSourceControlChangelistState::GetShelvedFilesStates() const
#endif
{
  return ShelvedFiles;
}

#if StartingInVersion(5, 4)
int32 FCheckpointSourceControlChangelistState::GetShelvedFilesStatesNum(
) const {
  return ShelvedFiles.Num();
}
#endif

FSourceControlChangelistRef
FCheckpointSourceControlChangelistState::GetChangelist() const {
  FCheckpointSourceControlChangelistRef ChangelistCopy =
    MakeShareable(new FCheckpointSourceControlChangelist(Changelist));
  return StaticCastSharedRef<ISourceControlChangelist>(ChangelistCopy);
}

#undef LOCTEXT_NAMESPACE
